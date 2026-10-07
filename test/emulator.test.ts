/**
 * End-to-end tests on the Firestore emulator: client + generated rules.
 * Run: npm run test:emulator (requires firebase CLI and Java).
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { Bytes, deleteDoc, doc, getDoc, setDoc, updateDoc, type Firestore } from 'firebase/firestore';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createFileStore, FileStoreError, type FileStoreConfig } from '../src/index.ts';
import { injectRules } from '../src/rules.ts';

const shared: FileStoreConfig = {
  collection: 'files',
  maxFileSize: 10_000,
  chunkSize: 1024,
  rules: { validate: '$new.author is string && $new.author.size() > 0' },
};
const priv: FileStoreConfig = {
  collection: 'private',
  chunksCollection: 'parts',
  maxFileSize: 4096,
  chunkSize: 1024,
  owner: true,
  rules: { read: '$owner' },
};

const RULES = injectRules(
  `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // firestore-files:begin files
    // firestore-files:end files
    // firestore-files:begin private
    // firestore-files:end private
  }
}
`,
  [shared, priv],
);

let env: RulesTestEnvironment;
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8181').split(':');

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-firestore-files',
    firestore: { rules: RULES, host, port: Number(port) },
  });
});
after(() => env?.cleanup());
beforeEach(() => env.clearFirestore());

const fs = (uid?: string) =>
  (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore() as unknown as Firestore;
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);
const sharedStore = (uid: string) => createFileStore<{ author: string }>(fs(uid), shared);
const privStore = (uid: string) => createFileStore(fs(uid), priv, { uid: () => uid });

test('upload, list and read: content matches byte for byte', async () => {
  const data = bytes(2500); // 3 chunks of 1024
  const progress: number[] = [];
  const f = await sharedStore('alice').upload(data, {
    name: 'a.bin',
    meta: { author: 'Alice' },
    onProgress: (p) => progress.push(p),
  });
  assert.equal(f.chunks, 3);
  assert.equal(progress.at(-1), 1);

  const bob = sharedStore('bob'); // another client — no cache
  const listed = await bob.list();
  assert.deepEqual(
    listed.map((x) => [x.name, x.author, x.size]),
    [['a.bin', 'Alice', 2500]],
  );
  const blob = await bob.read(f.id);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
});

test('empty file — one empty chunk', async () => {
  const f = await sharedStore('alice').upload(new Uint8Array(0), { name: 'empty', meta: { author: 'A' } });
  assert.equal(f.chunks, 1);
  assert.equal((await sharedStore('bob').read(f.id)).size, 0);
});

test('no reads without sign-in', async () => {
  const f = await sharedStore('alice').upload(bytes(10), { name: 'x', meta: { author: 'A' } });
  await assertFails(getDoc(doc(fs(), 'files', f.id)));
  await assertFails(getDoc(doc(fs(), 'files', f.id, 'chunks', '0')));
});

test('validate: custom fields are checked by rules', async () => {
  await assert.rejects(sharedStore('alice').upload(bytes(10), { name: 'x', meta: { author: '' } }));
  await assert.rejects(createFileStore(fs('alice'), shared).upload(bytes(10), { name: 'x' }));
});

test('limits: client and rules reject oversized files and chunks', async () => {
  await assert.rejects(sharedStore('alice').upload(bytes(10_001), { meta: { author: 'A' } }), (e: unknown) => {
    return e instanceof FileStoreError && e.code === 'too-large';
  });
  const db = fs('alice');
  const base = { name: 'x', type: 't', complete: false, createdAt: Date.now(), author: 'A' };
  // Size over the limit, bypassing the client
  await assertFails(setDoc(doc(db, 'files', 'big'), { ...base, size: 10_001, chunks: 10 }));
  // Chunk count does not match the size
  await assertFails(setDoc(doc(db, 'files', 'lie'), { ...base, size: 100, chunks: 2 }));
  await assertSucceeds(setDoc(doc(db, 'files', 'ok'), { ...base, size: 1500, chunks: 2 }));
  // Chunk larger than chunkSize, wrong index, index out of range
  await assertFails(setDoc(doc(db, 'files', 'ok', 'chunks', '0'), { i: 0, data: Bytes.fromUint8Array(bytes(1025)) }));
  await assertFails(setDoc(doc(db, 'files', 'ok', 'chunks', '1'), { i: 0, data: Bytes.fromUint8Array(bytes(10)) }));
  await assertFails(setDoc(doc(db, 'files', 'ok', 'chunks', '2'), { i: 2, data: Bytes.fromUint8Array(bytes(10)) }));
  await assertSucceeds(setDoc(doc(db, 'files', 'ok', 'chunks', '1'), { i: 1, data: Bytes.fromUint8Array(bytes(476)) }));
});

test('a complete file cannot be appended to or changed', async () => {
  const f = await sharedStore('alice').upload(bytes(100), { name: 'x', meta: { author: 'A' } });
  const db = fs('alice');
  await assertFails(setDoc(doc(db, 'files', f.id, 'chunks', '0'), { i: 0, data: Bytes.fromUint8Array(bytes(5)) }));
  await assertFails(updateDoc(doc(db, 'files', f.id), { complete: false }));
  await assertFails(updateDoc(doc(db, 'files', f.id), { name: 'renamed' }));
});

test('owner: only the owner reads and deletes', async () => {
  const data = bytes(3000, 7);
  const f = await privStore('alice').upload(data, { name: 'secret' });
  assert.equal(f.uid, 'alice');
  // Firestore rejects a query without an owner filter outright; with mine() — only own files
  await assert.rejects(privStore('bob').list());
  const bobStore = privStore('bob');
  assert.deepEqual(await bobStore.list(bobStore.mine()), []);
  const aliceStore = privStore('alice');
  assert.deepEqual(
    (await aliceStore.list(aliceStore.mine())).map((x) => x.id),
    [f.id],
  );
  await assert.rejects(privStore('bob').read(f.id));
  await assertFails(getDoc(doc(fs('bob'), 'private', f.id, 'parts', '0')));
  await assertFails(deleteDoc(doc(fs('bob'), 'private', f.id)));
  await assertFails(deleteDoc(doc(fs('bob'), 'private', f.id, 'parts', '0')));

  const alice = privStore('alice');
  assert.deepEqual(
    new Uint8Array(await (await createFileStore(fs('alice'), priv, { uid: () => 'alice' }).read(f.id)).arrayBuffer()),
    data,
  );
  await alice.remove(f.id);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    assert.equal((await getDoc(doc(db, 'private', f.id))).exists(), false);
    for (const n of ['0', '1', '2']) assert.equal((await getDoc(doc(db, 'private', f.id, 'parts', n))).exists(), false);
  });
});

test("owner: someone else's uid in metadata is rejected", async () => {
  await assert.rejects(createFileStore(fs('bob'), priv, { uid: () => 'alice' }).upload(bytes(10), { name: 'x' }));
});

test('corrupted content is caught by the checksum', async () => {
  const f = await sharedStore('alice').upload(bytes(2000), { name: 'x', meta: { author: 'A' } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    await setDoc(doc(db, 'files', f.id, 'chunks', '1'), { i: 1, data: Bytes.fromUint8Array(bytes(976, 99)) });
  });
  await assert.rejects(
    sharedStore('bob').read(f.id),
    (e: unknown) => e instanceof FileStoreError && e.code === 'corrupted',
  );
});

test('aborting an upload removes everything written', async () => {
  const ctrl = new AbortController();
  const store = createFileStore<{ author: string }>(fs('alice'), shared, { concurrency: 1 });
  await assert.rejects(
    store.upload(bytes(5000), {
      name: 'x',
      meta: { author: 'A' },
      signal: ctrl.signal,
      onProgress: (p) => p > 0.3 && ctrl.abort(),
    }),
    (e: unknown) => e instanceof FileStoreError && e.code === 'aborted',
  );
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    const { getDocs, collection } = await import('firebase/firestore');
    assert.equal((await getDocs(collection(db, 'files'))).size, 0);
  });
});

test('cleanupIncomplete and orphaned chunks', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    const old = { name: 'x', type: 't', size: 10, chunks: 1, complete: false, author: 'A' };
    await setDoc(doc(db, 'files', 'stale'), { ...old, createdAt: Date.now() - 2 * 3600_000 });
    await setDoc(doc(db, 'files', 'stale', 'chunks', '0'), { i: 0, data: Bytes.fromUint8Array(bytes(10)) });
    await setDoc(doc(db, 'files', 'fresh'), { ...old, createdAt: Date.now() });
    await setDoc(doc(db, 'files', 'gone', 'chunks', '0'), { i: 0, data: Bytes.fromUint8Array(bytes(10)) });
  });
  assert.equal(await sharedStore('alice').cleanupIncomplete(), 1);
  await assertSucceeds(deleteDoc(doc(fs('bob'), 'files', 'gone', 'chunks', '0')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    assert.equal((await getDoc(doc(db, 'files', 'stale'))).exists(), false);
    assert.equal((await getDoc(doc(db, 'files', 'stale', 'chunks', '0'))).exists(), false);
    assert.equal((await getDoc(doc(db, 'files', 'fresh'))).exists(), true);
  });
});

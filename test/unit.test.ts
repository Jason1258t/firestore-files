import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../src/config.ts';
import { generateRules, injectRules } from '../src/rules.ts';
import { BlobCache, mapLimit } from '../src/util.ts';

test('resolveConfig: значения по умолчанию', () => {
  const c = resolveConfig({ collection: 'files', maxFileSize: 25 * 1024 * 1024 });
  assert.equal(c.chunksCollection, 'chunks');
  assert.equal(c.chunkSize, 700 * 1024);
  assert.equal(c.maxChunks, 37);
  assert.equal(c.rules.delete, 'request.auth != null');
  assert.equal(c.checksum, true);
  assert.equal(resolveConfig({ collection: 'f', maxFileSize: 10, owner: true }).rules.delete, '$owner');
});

test('resolveConfig: ошибки конфига', () => {
  assert.throws(() => resolveConfig({ collection: 'a/b', maxFileSize: 1 }), /collection/);
  assert.throws(() => resolveConfig({ collection: 'f', maxFileSize: 1, chunkSize: 2_000_000 }), /chunkSize/);
  assert.throws(() => resolveConfig({ collection: 'f', maxFileSize: 0 }), /maxFileSize/);
  assert.throws(() => resolveConfig({ collection: 'f', maxFileSize: 1, rules: { read: '$owner' } }), /owner/);
  assert.throws(() => resolveConfig({ collection: 'f', maxFileSize: 1, rules: { write: '$file.x' } }), /rules.write/);
  assert.throws(() => resolveConfig({ collection: 'f', maxFileSize: 1, rules: { validate: '$file.x' } }), /\$new/);
  // $(database) в путях — не подстановка
  assert.doesNotThrow(() =>
    resolveConfig({
      collection: 'f',
      maxFileSize: 1,
      rules: { write: 'exists(/databases/$(database)/documents/x/y)' },
    }),
  );
});

test('generateRules: подставляет лимиты и выражения', () => {
  const r = generateRules({
    collection: 'docs',
    chunksCollection: 'parts',
    maxFileSize: 5000,
    chunkSize: 2048,
    owner: true,
    rules: { read: '$owner || $file.public == true', validate: '$new.author is string' },
  });
  assert.match(r, /match \/docs\/\{fileId\}/);
  assert.match(r, /match \/parts\/\{n\}/);
  assert.match(r, /d\.size <= 5000/);
  assert.match(r, /d\.chunks <= 3/);
  assert.match(r, /allow read: if \(resource\.data\.uid == request\.auth\.uid\) \|\| resource\.data\.public == true;/);
  assert.match(r, /allow read: if \(ffParent\(\)\.uid == request\.auth\.uid\) \|\| ffParent\(\)\.public == true;/);
  assert.match(r, /\(request\.resource\.data\.author is string\)/);
  assert.match(r, /d\.uid == request\.auth\.uid/);
  assert.doesNotMatch(r, /\$(file|new|owner)/);
});

test('injectRules: заменяет между маркерами, сохраняет отступ, идемпотентно', () => {
  const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /other/{id} { allow read: if true; }
      // firestore-files:begin files
      старое
      // firestore-files:end files
  }
}
`;
  const cfg = { collection: 'files', maxFileSize: 1000 };
  const once = injectRules(src, cfg);
  assert.doesNotMatch(once, /старое/);
  assert.match(once, /\n {6}match \/files\/\{fileId\}/);
  assert.match(once, /match \/other\/\{id\}/);
  assert.equal(injectRules(once, cfg), once);
  assert.throws(() => injectRules(src, { collection: 'nope', maxFileSize: 1 }), /маркеров/);
});

test('mapLimit: порядок и ограничение параллельности', async () => {
  let running = 0;
  let peak = 0;
  const res = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, n * 3));
    running--;
    return n * 10;
  });
  assert.deepEqual(res, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
  await assert.rejects(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});

test('BlobCache: вытесняет старые по размеру', () => {
  const c = new BlobCache(100);
  const b = Promise.resolve(new Blob([]));
  c.set('a', b, 60);
  c.set('b', b, 30);
  c.get('a'); // a становится свежим
  c.set('c', b, 30); // 120 > 100 — вытесняется самый старый: b
  assert.ok(c.get('a'));
  assert.equal(c.get('b'), undefined);
  assert.ok(c.get('c'));
});

/** Хуки на эмуляторе Firestore: рендер через react-dom в happy-dom */
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { where, type Firestore } from 'firebase/firestore';
import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createFileStore, type FileStore, type FileStoreConfig } from '../src/index.ts';
import { useFiles, useFileUrl, useUpload } from '../src/react.ts';
import { injectRules } from '../src/rules.ts';

// DOM для react-dom; Blob/URL остаются нодовские — с ними работает хранилище
const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, IS_REACT_ACT_ENVIRONMENT: true });

const config: FileStoreConfig = { collection: 'files', maxFileSize: 20_000, chunkSize: 1024 };
const RULES = injectRules(
  `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // firestore-files:begin files
    // firestore-files:end files
  }
}
`,
  config,
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

type Meta = { tag: string };
const makeStore = (uid: string) =>
  createFileStore<Meta>(env.authenticatedContext(uid).firestore() as unknown as Firestore, config);
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

/** Рендерит хук и отдаёт «живую» ссылку на последний результат */
function renderHook<T>(hook: () => T) {
  const box = { current: undefined as T };
  const Probe = () => {
    box.current = hook();
    return null;
  };
  const root = createRoot(win.document.createElement('div') as unknown as Element);
  act(() => root.render(createElement(Probe)));
  return { box, unmount: () => act(() => root.unmount()) };
}

async function waitFor(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor: не дождались');
    await act(() => new Promise((r) => setTimeout(r, 20)));
  }
}

test('useUpload + useFiles: прогресс, появление в списке, фильтр по deps', async () => {
  const store = makeStore('alice');
  let setTag: (t: string) => void = () => {};
  const h = renderHook(() => {
    const [tag, set] = useState('a');
    setTag = set;
    return {
      list: useFiles(store, [where('tag', '==', tag)], [tag]),
      up: useUpload(store, { keepDone: true }),
    };
  });
  await waitFor(() => !h.box.current.list.loading);
  assert.equal(h.box.current.list.files.length, 0);

  let p!: Promise<unknown>;
  act(() => {
    p = h.box.current.up.upload(bytes(5000), { name: 'a.bin', meta: { tag: 'a' } });
  });
  assert.equal(h.box.current.up.uploading, true);
  await act(() => p);
  const task = h.box.current.up.tasks[0];
  assert.equal(task.status, 'done');
  assert.equal(task.progress, 1);
  await waitFor(() => h.box.current.list.files.length === 1);
  assert.equal(h.box.current.list.files[0].name, 'a.bin');

  // Смена фильтра пересоздаёт подписку
  act(() => setTag('b'));
  await waitFor(() => !h.box.current.list.loading && h.box.current.list.files.length === 0);
  h.unmount();
});

test('useUpload: отмена и ошибка остаются в tasks, dismiss убирает', async () => {
  const store = makeStore('alice');
  const h = renderHook(() => useUpload(store));
  let p!: Promise<unknown>;
  act(() => {
    p = h.box.current.upload(bytes(15_000), { meta: { tag: 'x' } });
  });
  const key = h.box.current.tasks[0].key;
  act(() => h.box.current.cancel(key));
  await act(() => p.catch(() => {}));
  assert.equal(h.box.current.tasks[0].status, 'cancelled');

  await act(() => h.box.current.upload(bytes(25_000), { meta: { tag: 'x' } }).catch(() => {}));
  assert.equal(h.box.current.tasks[1].status, 'error');
  act(() => h.box.current.dismiss());
  assert.deepEqual(h.box.current.tasks, []);
  h.unmount();
});

test('useFileUrl: object URL с содержимым файла; null — пусто', async () => {
  const data = bytes(3000);
  const f = await makeStore('alice').upload(data, { name: 'img', meta: { tag: 't' } });
  const store: FileStore<Meta> = makeStore('bob');
  let setId: (v: string | null) => void = () => {};
  const h = renderHook(() => {
    const [id, set] = useState<string | null>(null);
    setId = set;
    return useFileUrl(store, id);
  });
  assert.deepEqual(h.box.current, { url: null, loading: false, error: null });
  act(() => setId(f.id));
  await waitFor(() => Boolean(h.box.current.url));
  const res = await fetch(h.box.current.url!).catch(() => null);
  // Node не всегда умеет fetch(blob:) — тогда сверяем через кеш хранилища
  const got = res
    ? new Uint8Array(await res.arrayBuffer())
    : new Uint8Array(await (await store.read(f.id)).arrayBuffer());
  assert.deepEqual(got, data);

  act(() => setId('missing'));
  await waitFor(() => Boolean(h.box.current.error));
  h.unmount();
});

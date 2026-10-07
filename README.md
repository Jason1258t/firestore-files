# firestore-files

**English** · [Русский](README.ru.md)

Files in Cloud Firestore — no Firebase Storage, no Blaze plan.

A file is split into ~700 KiB chunks, because a Firestore document is limited to 1 MiB. Chunks live in a subcollection, metadata in a separate document. Everything is driven by one config shared by the client and the security rules: the collection name, limits, and who can read, write and delete. Rules are generated from the config, so the client and `firestore.rules` never drift apart.

```
<collection>/{fileId}                    name, size, type, chunks, complete, createdAt, [uid], [sha256], …your fields
<collection>/{fileId}/<chunks>/{n}       { i: n, data: Bytes }
```

A file appears in `list()` and `subscribe()` only after all its chunks are written (`complete: true`). An interrupted upload cleans up after itself. If the tab was closed mid-upload, `cleanupIncomplete()` removes the leftovers.

## When it fits

- Attachments, screenshots, data packs and other files up to tens of megabytes in a small project on the free plan.
- You want Firestore's offline cache, its security rules and App Check — without another service.

When it does **not** fit — this is the price of the approach:

- **Quotas.** Each chunk is one write on upload and one read on download. The free tier gives 20,000 writes, 50,000 reads and 1 GiB of storage per day. A 25 MB file is 37 writes, and 37 reads on every download. The file is not kept in Firestore's cache, so reopening it reads it again.
- **Video, public distribution, large volumes** — use Storage or a CDN for that.
- **Speed.** The chunk rule does a `get()` of the parent. That is one more read per chunk on write, and on download too if the read rule uses `$file`.

## Installation

```bash
npm i firestore-files firebase
```

Requires `firebase` ≥ 10 (modular API). The package is ESM-only.

## Config

`firestore-files.config.mjs` in the project root — the CLI reads it, and the client imports the same object (see [`firestore-files.config.example.mjs`](firestore-files.config.example.mjs)):

```js
import { defineConfig } from 'firestore-files/rules';

export default defineConfig({
  collection: 'files',
  maxFileSize: 25 * 1024 * 1024,
  // chunksCollection: 'chunks',
  // chunkSize: 700 * 1024,       // up to 1 000 000
  owner: true, // store the uploader's uid
  // checksum: true,              // SHA-256 on upload, verified on read
  rules: {
    read: 'request.auth != null',
    write: 'request.auth != null',
    delete: '$owner', // defaults to $owner with owner: true, otherwise any signed-in user
    validate: '$new.author is string && $new.author.size() <= 40',
  },
});
```

You can export an array of configs — for several collections with different limits.

### Access rules

Rules are Firestore rules language expressions. You can call your own functions from `firestore.rules`, such as `signedIn()` or `isAdmin()`. Available placeholders:

| Placeholder | Meaning                                                                 | Where            |
| ----------- | ----------------------------------------------------------------------- | ---------------- |
| `$file`     | metadata of an existing file (in chunk rules — a `get()` of the parent) | `read`, `delete` |
| `$owner`    | the current user uploaded the file (requires `owner: true`)             | `read`, `delete` |
| `$new`      | metadata of the file being created                                      | `validate`       |

`write` is checked when the file is created, when chunks are written and when the file is marked complete. It has no placeholders: the file does not exist yet. With `owner: true` the package adds the uploader check itself.

The package also enforces the internals: file and chunk sizes within limits, chunk count matching the size, each chunk written under its own index and only into an incomplete file. A complete file can be neither appended to nor changed.

## Rules: generation

In `firestore.rules`, inside `match /databases/{database}/documents`, add the markers:

```
    // firestore-files:begin files
    // firestore-files:end files
```

Then:

```bash
npx firestore-files rules --write firestore.rules          # insert / update
npx firestore-files rules --write firestore.rules --check  # in CI: fail if the rules are out of date
npx firestore-files rules                                  # just print
```

There is a programmatic API too — `generateRules(config)` and `injectRules(source, config)` from `firestore-files/rules`.

## Client

```ts
import { createFileStore } from 'firestore-files';
import config from './firestore-files.config.mjs';

const files = createFileStore<{ author: string; taskId: string | null }>(db, config, {
  ready: () => authReady, // wait for sign-in before any request
  uid: () => auth.currentUser?.uid, // required with owner: true
});

const f = await files.upload(file, { meta: { author: 'Steve', taskId }, onProgress: (p) => setProgress(p) });
const list = await files.list(where('taskId', '==', taskId), orderBy('createdAt'));
const stop = files.subscribe([where('taskId', '==', taskId)], setFiles);
img.src = await files.objectUrl(f); // cached; free it with files.release(f.id)
await files.download(f);
await files.remove(f);
```

With `owner: true` and a `$owner` read rule, Firestore rejects a list query without an owner filter outright: it could match other users' documents. Use `files.list(files.mine())`.

Errors are `FileStoreError` with a `code` field: `too-large`, `not-found`, `incomplete`, `corrupted`, `aborted`, `reserved-field`, `no-user`. Messages are in English; switch on `code` to show your own localized text. An upload can be cancelled via `signal` (AbortController).

## React

`firestore-files/react` is an optional entry point; `react` ≥ 18 is an optional peer dependency. Create the store (`fileStore` in the example — the result of `createFileStore`) once: outside the component or in `useMemo`.

```tsx
import { useFiles, useFileUrl, useUpload } from 'firestore-files/react';

function Attachments({ taskId }: { taskId: string }) {
  // Re-subscribes when deps change; pass null instead of constraints to disable
  const { files, loading, error } = useFiles(fileStore, [where('taskId', '==', taskId)], [taskId]);
  const { upload, tasks, cancel, dismiss } = useUpload(fileStore);

  return (
    <>
      <input
        type="file"
        multiple
        onChange={(e) => [...e.target.files!].forEach((f) => upload(f, { meta: { taskId } }))}
      />
      {tasks.map((t) => (
        <Progress key={t.key} value={t.progress} error={t.error} onCancel={() => cancel(t.key)} />
      ))}
      {files.map((f) => (
        <Thumb key={f.id} file={f} />
      ))}
    </>
  );
}

function Thumb({ file }) {
  const { url } = useFileUrl(fileStore, file); // content is cached — not downloaded again
  return url ? <img src={url} /> : null;
}
```

- **`useFiles(store, constraints | null, deps)`** returns `{ files, loading, error }` and updates in real time.
- **`useFileUrl(store, file | id | null)`** returns `{ url, loading, error }`. The URL is shared by every place that shows the file, so it is not revoked on unmount. Call `store.release(id)` when the file is no longer needed.
- **`useUpload(store, { keepDone })`** returns `{ tasks, uploading, upload, cancel, dismiss }`. Supports parallel uploads, progress and cancellation. Failed or cancelled tasks stay in `tasks` until `dismiss()` removes them. On unmount, unfinished uploads are aborted and cleaned up.

## Migrating from a hand-rolled store

If your files are already in Firestore in the same format (metadata `name`, `size`, `type`, `chunks`, `complete`, `createdAt` in ms, optional `uid` and `sha256`; chunks `{ i, data: Bytes }` in a subcollection), the package works with them as is, no data migration:

1. Set `collection` and `chunksCollection` to the existing names, and `chunkSize` to the size the files were split with. Rule limits are derived from it: with a different chunk size old files still read fine, but the rules will not match how the old client writes.
2. If the uploader's uid was stored in `uid`, enable `owner: true`.
3. Old files without `sha256` are read without a checksum check — no need to disable `checksum`. New uploads get `sha256` automatically.
4. Generate the rules (`npx firestore-files rules --write firestore.rules`) and remove the old rules for that collection from `firestore.rules`.
5. If documents carry your own fields, validate them in `rules.validate` — otherwise the rules accept any extra fields.

## Tests

```bash
npm test                 # unit
npm run test:emulator    # end-to-end on the Firestore emulator (requires firebase CLI and Java)
```

End-to-end tests check the client and the generated rules together:

- upload and byte-exact read, empty file;
- access without sign-in;
- `validate`;
- size and chunk limits bypassing the client;
- appending to a complete file is rejected;
- `owner` and `mine()`;
- content corruption;
- aborted upload;
- `cleanupIncomplete` and orphaned chunks.

## License

[MIT](LICENSE)

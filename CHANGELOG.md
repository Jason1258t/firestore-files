# Changelog

## 0.1.0 — 2026-10-07

First release.

- Files stored in Cloud Firestore as chunks (~700 KiB by default): metadata in `<collection>/{id}`, content in `<collection>/{id}/<chunks>/{n}` as `{ i, data: Bytes }`. No Firebase Storage or Blaze plan required.
- One config (`defineConfig`) shared by the client and the security rules: collection names, file and chunk size limits, owner tracking, checksum, and `read` / `write` / `delete` / `validate` rule expressions with `$file`, `$owner` and `$new` placeholders.
- Rules generator: `generateRules()` / `injectRules()` from `firestore-files/rules` and the `firestore-files rules` CLI with `--write` and `--check` (for CI). Generated rules enforce size limits, chunk count, chunk indices and immutability of complete files.
- Client (`createFileStore`): `upload` with progress and `AbortSignal`, `get`, `list`, `subscribe`, `read`, `objectUrl` / `release` with an in-memory LRU cache, `download`, `remove`, `cleanupIncomplete`, `mine()`.
- SHA-256 checksum on upload, verified on read; files without `sha256` are read without verification.
- Interrupted uploads clean up their chunks and metadata.
- `FileStoreError` with `code`: `too-large`, `not-found`, `incomplete`, `corrupted`, `aborted`, `reserved-field`, `no-user`.
- React hooks in `firestore-files/react`: `useFiles`, `useFileUrl`, `useUpload`.

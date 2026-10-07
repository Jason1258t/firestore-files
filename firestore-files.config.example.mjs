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

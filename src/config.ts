/**
 * One config for the client and the rules generator: the collection name, limits and access
 * conditions live in one place, so the client and firestore.rules never drift apart.
 */
export interface FileStoreConfig {
  /** Collection that holds file metadata */
  collection: string;
  /** Subcollection that holds content chunks. Defaults to `chunks` */
  chunksCollection?: string;
  /** Maximum file size in bytes */
  maxFileSize: number;
  /**
   * Chunk size in bytes. A Firestore document is limited to 1 MiB including field names,
   * so it cannot exceed 1 000 000. Defaults to 700 KiB, which leaves headroom.
   */
  chunkSize?: number;
  /**
   * Store the uploader's uid (field `uid`). Then only the uploader can write chunks and mark
   * the file complete, and `$owner` in rules means "the current user owns this file".
   */
  owner?: boolean;
  /** Compute SHA-256 on upload and verify it on read. Defaults to true */
  checksum?: boolean;
  /** Access conditions — Firestore rules expressions, see {@link FileStoreRules} */
  rules?: FileStoreRules;
}

/**
 * Firestore rules expressions. Placeholders:
 * - `$file` — metadata of an existing file (in chunk rules this is a get() of the parent);
 * - `$new` — metadata of the file being created (only in `validate`);
 * - `$owner` — the current user uploaded this file (requires `owner: true`).
 *
 * You can call your own functions declared in firestore.rules above the package block.
 */
export interface FileStoreRules {
  /** Who can read metadata and content. Defaults to any signed-in user */
  read?: string;
  /** Who can upload files. Defaults to any signed-in user */
  write?: string;
  /** Who can delete. Defaults to the owner with `owner: true`, otherwise any signed-in user */
  delete?: string;
  /** Extra validation of your own metadata fields on create, e.g. `$new.author is string` */
  validate?: string;
}

export interface ResolvedConfig {
  collection: string;
  chunksCollection: string;
  maxFileSize: number;
  chunkSize: number;
  maxChunks: number;
  owner: boolean;
  checksum: boolean;
  rules: Required<FileStoreRules>;
}

/** Fields managed by the package; custom metadata cannot override them */
export const RESERVED_FIELDS = ['name', 'size', 'type', 'chunks', 'complete', 'createdAt', 'uid', 'sha256'] as const;

export const DEFAULT_CHUNK_SIZE = 700 * 1024;
export const MAX_CHUNK_SIZE = 1_000_000;

const SIGNED_IN = 'request.auth != null';
const NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Gives type hints in the config file */
export function defineConfig<C extends FileStoreConfig | FileStoreConfig[]>(config: C): C {
  return config;
}

export function resolveConfig(config: FileStoreConfig): ResolvedConfig {
  const chunksCollection = config.chunksCollection ?? 'chunks';
  for (const [key, value] of [
    ['collection', config.collection],
    ['chunksCollection', chunksCollection],
  ] as const) {
    if (!NAME_RE.test(value)) throw new Error(`firestore-files: ${key} "${value}" — only A-Z a-z 0-9 _ - are allowed`);
  }
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > MAX_CHUNK_SIZE)
    throw new Error(`firestore-files: chunkSize must be an integer from 1024 to ${MAX_CHUNK_SIZE}`);
  if (!Number.isInteger(config.maxFileSize) || config.maxFileSize < 1)
    throw new Error('firestore-files: maxFileSize must be a positive integer');

  const owner = config.owner ?? false;
  const rules = config.rules ?? {};
  const resolved: ResolvedConfig = {
    collection: config.collection,
    chunksCollection,
    maxFileSize: config.maxFileSize,
    chunkSize,
    maxChunks: Math.max(1, Math.ceil(config.maxFileSize / chunkSize)),
    owner,
    checksum: config.checksum ?? true,
    rules: {
      read: rules.read ?? SIGNED_IN,
      write: rules.write ?? SIGNED_IN,
      delete: rules.delete ?? (owner ? '$owner' : SIGNED_IN),
      validate: rules.validate ?? 'true',
    },
  };
  // write and validate run on create, when the file does not exist yet; read and delete — on an existing one
  const allowed: Record<keyof FileStoreRules, string[]> = {
    read: ['$file', '$owner'],
    delete: ['$file', '$owner'],
    write: [],
    validate: ['$new'],
  };
  for (const [key, expr] of Object.entries(resolved.rules) as [keyof FileStoreRules, string][]) {
    for (const ph of expr.match(/\$[a-z]+/g) ?? []) {
      if (!allowed[key].includes(ph))
        throw new Error(
          `firestore-files: ${ph} is not allowed in rules.${key}` +
            (allowed[key].length
              ? ` (available: ${allowed[key].join(', ')})`
              : ' — no placeholders are available here'),
        );
    }
    if (!owner && expr.includes('$owner'))
      throw new Error(`firestore-files: rules.${key} uses $owner, but owner is not enabled`);
  }
  return resolved;
}

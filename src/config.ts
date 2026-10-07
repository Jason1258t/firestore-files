/**
 * Один конфиг на клиент и на генератор правил: имя коллекции, лимиты и условия доступа
 * задаются в одном месте, поэтому клиент и firestore.rules не разъезжаются.
 */
export interface FileStoreConfig {
  /** Коллекция с метаданными файлов */
  collection: string;
  /** Подколлекция с кусками содержимого. По умолчанию `chunks` */
  chunksCollection?: string;
  /** Максимальный размер файла в байтах */
  maxFileSize: number;
  /**
   * Размер куска в байтах. Документ Firestore ограничен 1 MiB вместе с именами полей,
   * поэтому больше 1 000 000 нельзя. По умолчанию 700 КиБ — с запасом.
   */
  chunkSize?: number;
  /**
   * Хранить uid загрузившего (поле `uid`). Тогда дописывать куски и отмечать файл готовым
   * может только он, а `$owner` в правилах означает «текущий пользователь — владелец».
   */
  owner?: boolean;
  /** Считать SHA-256 при загрузке и проверять при чтении. По умолчанию true */
  checksum?: boolean;
  /** Условия доступа — выражения языка правил Firestore, см. {@link FileStoreRules} */
  rules?: FileStoreRules;
}

/**
 * Выражения правил Firestore. Подстановки:
 * - `$file` — метаданные существующего файла (в правилах кусков это get() родителя);
 * - `$new` — метаданные создаваемого файла (только в `validate`);
 * - `$owner` — текущий пользователь загрузил этот файл (нужен `owner: true`).
 *
 * Можно вызывать свои функции, объявленные в firestore.rules выше блока пакета.
 */
export interface FileStoreRules {
  /** Кто читает метаданные и содержимое. По умолчанию — любой вошедший */
  read?: string;
  /** Кто загружает файлы. По умолчанию — любой вошедший */
  write?: string;
  /** Кто удаляет. По умолчанию — владелец при `owner: true`, иначе любой вошедший */
  delete?: string;
  /** Дополнительная проверка своих полей метаданных при создании. Например `$new.author is string` */
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

/** Поля, которыми управляет пакет; свои метаданные не могут их перекрывать */
export const RESERVED_FIELDS = ['name', 'size', 'type', 'chunks', 'complete', 'createdAt', 'uid', 'sha256'] as const;

export const DEFAULT_CHUNK_SIZE = 700 * 1024;
export const MAX_CHUNK_SIZE = 1_000_000;

const SIGNED_IN = 'request.auth != null';
const NAME_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Для подсказок типов в файле конфига */
export function defineConfig<C extends FileStoreConfig | FileStoreConfig[]>(config: C): C {
  return config;
}

export function resolveConfig(config: FileStoreConfig): ResolvedConfig {
  const chunksCollection = config.chunksCollection ?? 'chunks';
  for (const [key, value] of [
    ['collection', config.collection],
    ['chunksCollection', chunksCollection],
  ] as const) {
    if (!NAME_RE.test(value)) throw new Error(`firestore-files: ${key} «${value}» — допустимы только A-Z a-z 0-9 _ -`);
  }
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > MAX_CHUNK_SIZE)
    throw new Error(`firestore-files: chunkSize должен быть целым от 1024 до ${MAX_CHUNK_SIZE}`);
  if (!Number.isInteger(config.maxFileSize) || config.maxFileSize < 1)
    throw new Error('firestore-files: maxFileSize должен быть положительным целым');

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
  // write и validate проверяются при создании, когда файла ещё нет; read и delete — на существующем
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
          `firestore-files: в rules.${key} нельзя ${ph}` +
            (allowed[key].length ? ` (доступно: ${allowed[key].join(', ')})` : ' — подстановки здесь недоступны'),
        );
    }
    if (!owner && expr.includes('$owner'))
      throw new Error(`firestore-files: rules.${key} использует $owner, но owner не включён`);
  }
  return resolved;
}

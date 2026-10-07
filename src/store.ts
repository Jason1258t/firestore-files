import {
  Bytes,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type Firestore,
  type QueryConstraint,
} from 'firebase/firestore';
import { RESERVED_FIELDS, resolveConfig, type FileStoreConfig, type ResolvedConfig } from './config.ts';
import { BlobCache, mapLimit, sha256Hex } from './util.ts';

/**
 * Файлы в Firestore без Firebase Storage: метаданные в `<collection>/{id}`,
 * содержимое — кусками в `<collection>/{id}/<chunksCollection>/{n}` как { i, data: Bytes }.
 * Файл виден в списках только после записи всех кусков (complete: true).
 */
export interface FileBase {
  id: string;
  name: string;
  size: number;
  type: string;
  chunks: number;
  complete: boolean;
  createdAt: number;
  uid?: string;
  sha256?: string;
}

/** Метаданные файла: служебные поля + свои поля M (лежат в том же документе) */
export type StoredFile<M extends object = Record<string, never>> = FileBase & M;

export interface UploadOptions<M extends object> {
  name?: string;
  type?: string;
  /** Свои поля метаданных (например taskId, author) */
  meta?: M;
  /** Свой id документа (по умолчанию — автоматический) */
  id?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface FileStoreOptions {
  /** Дождаться перед любой операцией — например входа анонимного пользователя */
  ready?: () => Promise<unknown>;
  /** uid текущего пользователя — нужен при `owner: true` */
  uid?: () => string | null | undefined;
  /** Сколько кусков писать/читать параллельно. По умолчанию 4 */
  concurrency?: number;
  /** Сколько байт собранных файлов держать в памяти. По умолчанию 64 МиБ */
  cacheBytes?: number;
}

export class FileStoreError extends Error {
  readonly code: 'too-large' | 'not-found' | 'incomplete' | 'corrupted' | 'aborted' | 'reserved-field' | 'no-user';
  constructor(code: FileStoreError['code'], message: string) {
    super(message);
    this.name = 'FileStoreError';
    this.code = code;
  }
}

export interface FileStore<M extends object> {
  readonly config: ResolvedConfig;
  upload(data: Blob | Uint8Array, opts?: UploadOptions<M>): Promise<StoredFile<M>>;
  get(id: string): Promise<StoredFile<M> | null>;
  /** Готовые файлы (complete == true) с доп. условиями: where(), orderBy(), limit() */
  list(...constraints: QueryConstraint[]): Promise<StoredFile<M>[]>;
  subscribe(
    constraints: QueryConstraint[],
    onNext: (files: StoredFile<M>[]) => void,
    onError?: (e: Error) => void,
  ): () => void;
  /** Собирает содержимое; результат кешируется */
  read(file: StoredFile<M> | string): Promise<Blob>;
  /** object URL (для <img>, <a download>); живёт, пока не вызван release() */
  objectUrl(file: StoredFile<M> | string): Promise<string>;
  release(id: string): void;
  /** Скачивание в браузере */
  download(file: StoredFile<M> | string): Promise<void>;
  remove(file: StoredFile<M> | string): Promise<void>;
  /** Удаляет незавершённые загрузки старше maxAgeMs (по умолчанию час) — остатки оборванных вкладок */
  cleanupIncomplete(maxAgeMs?: number): Promise<number>;
  /**
   * Условие «мои файлы» (where uid == текущий). Нужно в list()/subscribe(), если чтение
   * ограничено владельцем: Firestore отклоняет запрос целиком, если он может задеть чужие документы.
   */
  mine(): QueryConstraint;
}

export function createFileStore<M extends object = Record<string, never>>(
  db: Firestore,
  configInput: FileStoreConfig,
  options: FileStoreOptions = {},
): FileStore<M> {
  const config = resolveConfig(configInput);
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const ready = async () => {
    await options.ready?.();
  };
  const blobs = new BlobCache(options.cacheBytes ?? 64 * 1024 * 1024);
  const urls = new Map<string, Promise<string>>();

  const col = () => collection(db, config.collection);
  const chunkRef = (id: string, i: number) => doc(db, config.collection, id, config.chunksCollection, String(i));
  const toFile = (id: string, data: DocumentData) => ({ ...data, id }) as StoredFile<M>;

  async function resolve(file: StoredFile<M> | string): Promise<StoredFile<M>> {
    if (typeof file !== 'string') return file;
    const f = await get(file);
    if (!f) throw new FileStoreError('not-found', `Файл ${file} не найден`);
    return f;
  }

  async function get(id: string) {
    await ready();
    const snap = await getDoc(doc(db, config.collection, id));
    return snap.exists() ? toFile(snap.id, snap.data()) : null;
  }

  async function deleteChunks(id: string, chunks: number) {
    // По одному, а не батчем: правило куска делает get() родителя, а у батча общий лимит на такие вызовы
    await mapLimit(
      Array.from({ length: chunks }, (_, i) => i),
      concurrency,
      (i) => deleteDoc(chunkRef(id, i)),
    );
  }

  async function upload(data: Blob | Uint8Array, opts: UploadOptions<M> = {}): Promise<StoredFile<M>> {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
    if (blob.size > config.maxFileSize)
      throw new FileStoreError('too-large', `Файл больше допустимого (${config.maxFileSize} байт)`);
    for (const key of Object.keys(opts.meta ?? {})) {
      if ((RESERVED_FIELDS as readonly string[]).includes(key) || key === 'id')
        throw new FileStoreError('reserved-field', `Поле «${key}» служебное и не может быть в meta`);
    }
    await ready();
    let uid: string | undefined;
    if (config.owner) {
      uid = options.uid?.() ?? undefined;
      if (!uid) throw new FileStoreError('no-user', 'owner: true, но пользователь не определён (options.uid)');
    }

    const ref = opts.id ? doc(db, config.collection, opts.id) : doc(col());
    const chunks = Math.max(1, Math.ceil(blob.size / config.chunkSize));
    const meta: Omit<FileBase, 'id'> & Record<string, unknown> = {
      ...(opts.meta ?? {}),
      name: opts.name ?? (blob instanceof File ? blob.name : 'file'),
      size: blob.size,
      type: opts.type || blob.type || 'application/octet-stream',
      chunks,
      complete: false,
      createdAt: Date.now(),
    };
    if (uid) meta.uid = uid;
    if (config.checksum) meta.sha256 = await sha256Hex(blob);

    const abortCheck = () => {
      if (opts.signal?.aborted) throw new FileStoreError('aborted', 'Загрузка отменена');
    };
    abortCheck();
    await setDoc(ref, meta);
    try {
      let done = 0;
      await mapLimit(
        Array.from({ length: chunks }, (_, i) => i),
        concurrency,
        async (i) => {
          abortCheck();
          const part = new Uint8Array(await blob.slice(i * config.chunkSize, (i + 1) * config.chunkSize).arrayBuffer());
          await setDoc(chunkRef(ref.id, i), { i, data: Bytes.fromUint8Array(part) });
          opts.onProgress?.(++done / chunks);
        },
      );
      abortCheck();
      await updateDoc(ref, { complete: true });
    } catch (e) {
      // Недокачанный файл не оставляем
      await deleteChunks(ref.id, chunks).catch(() => {});
      await deleteDoc(ref).catch(() => {});
      throw e;
    }
    const stored = toFile(ref.id, { ...meta, complete: true });
    blobs.set(ref.id, Promise.resolve(blob), blob.size);
    return stored;
  }

  async function list(...constraints: QueryConstraint[]) {
    await ready();
    const snap = await getDocs(query(col(), where('complete', '==', true), ...constraints));
    return snap.docs.map((d) => toFile(d.id, d.data()));
  }

  function subscribe(
    constraints: QueryConstraint[],
    onNext: (files: StoredFile<M>[]) => void,
    onError?: (e: Error) => void,
  ) {
    let unsub = () => {};
    let cancelled = false;
    ready().then(
      () => {
        if (cancelled) return;
        unsub = onSnapshot(
          query(col(), where('complete', '==', true), ...constraints),
          (snap) => onNext(snap.docs.map((d) => toFile(d.id, d.data()))),
          (e) => onError?.(e),
        );
      },
      (e) => onError?.(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }

  async function assemble(f: StoredFile<M>): Promise<Blob> {
    if (!f.complete) throw new FileStoreError('incomplete', `Файл «${f.name}» ещё загружается`);
    await ready();
    const parts = await mapLimit(
      Array.from({ length: f.chunks }, (_, i) => i),
      concurrency,
      async (i) => {
        const snap = await getDoc(chunkRef(f.id, i));
        const data = snap.data() as { data?: Bytes } | undefined;
        if (!data?.data) throw new FileStoreError('corrupted', `Файл «${f.name}» повреждён: нет куска ${i}`);
        return data.data.toUint8Array();
      },
    );
    const blob = new Blob(parts as BlobPart[], { type: f.type });
    if (blob.size !== f.size)
      throw new FileStoreError('corrupted', `Файл «${f.name}» повреждён: ${blob.size} байт вместо ${f.size}`);
    if (f.sha256 && config.checksum && (await sha256Hex(blob)) !== f.sha256)
      throw new FileStoreError('corrupted', `Файл «${f.name}» повреждён: не совпала контрольная сумма`);
    return blob;
  }

  function read(file: StoredFile<M> | string): Promise<Blob> {
    const id = typeof file === 'string' ? file : file.id;
    const cached = blobs.get(id);
    if (cached) return cached;
    const p = resolve(file).then(assemble);
    blobs.set(id, p);
    p.then(
      (b) => blobs.setSize(id, b.size),
      () => blobs.delete(id),
    );
    return p;
  }

  function objectUrl(file: StoredFile<M> | string): Promise<string> {
    const id = typeof file === 'string' ? file : file.id;
    let p = urls.get(id);
    if (!p) {
      p = read(file).then((b) => URL.createObjectURL(b));
      p.catch(() => urls.delete(id));
      urls.set(id, p);
    }
    return p;
  }

  function release(id: string) {
    urls.get(id)?.then(
      (u) => URL.revokeObjectURL(u),
      () => {},
    );
    urls.delete(id);
    blobs.delete(id);
  }

  async function download(file: StoredFile<M> | string) {
    const f = await resolve(file);
    const url = URL.createObjectURL(await read(f));
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function remove(file: StoredFile<M> | string) {
    const f = await resolve(file);
    await ready();
    // Сначала куски, потом метаданные: при сбое файл остаётся в списке и его можно удалить снова
    await deleteChunks(f.id, f.chunks);
    await deleteDoc(doc(db, config.collection, f.id));
    release(f.id);
  }

  async function cleanupIncomplete(maxAgeMs = 60 * 60 * 1000) {
    await ready();
    const snap = await getDocs(query(col(), where('complete', '==', false)));
    const stale = snap.docs.filter((d) => (d.data().createdAt ?? 0) < Date.now() - maxAgeMs);
    for (const d of stale) {
      await deleteChunks(d.id, d.data().chunks ?? 0);
      await deleteDoc(d.ref);
    }
    return stale.length;
  }

  function mine() {
    const uid = options.uid?.();
    if (!config.owner || !uid) throw new FileStoreError('no-user', 'mine() требует owner: true и options.uid');
    return where('uid', '==', uid);
  }

  return { config, upload, get, list, subscribe, read, objectUrl, release, download, remove, cleanupIncomplete, mine };
}

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { QueryConstraint } from 'firebase/firestore';
import type { FileStore, StoredFile, UploadOptions } from './store.ts';

/**
 * React-обёртки над FileStore: точка входа `firestore-files/react`.
 * Хранилище создавайте один раз — вне компонента или в useMemo.
 */

export interface FilesState<M extends object> {
  files: StoredFile<M>[];
  loading: boolean;
  error: Error | null;
}

/**
 * Готовые файлы с живым обновлением. Ограничения запроса — массив, который создаётся
 * на каждом рендере, поэтому пересоздание подписки управляется `deps`, как в useEffect.
 * `constraints = null` — подписка выключена (например, пока нет taskId).
 *
 *     const { files } = useFiles(store, taskId ? [where('taskId', '==', taskId)] : null, [taskId]);
 */
export function useFiles<M extends object>(
  store: FileStore<M>,
  constraints: QueryConstraint[] | null = [],
  deps: DependencyList = [],
): FilesState<M> {
  const [state, setState] = useState<FilesState<M>>({ files: [], loading: constraints !== null, error: null });
  const enabled = constraints !== null;
  const constraintsRef = useRef(constraints);
  constraintsRef.current = constraints;

  useEffect(() => {
    if (!enabled) {
      setState({ files: [], loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    return store.subscribe(
      constraintsRef.current ?? [],
      (files) => setState({ files, loading: false, error: null }),
      (error) => setState((s) => ({ ...s, loading: false, error })),
    );
    // constraints намеренно не в зависимостях: новый массив на каждом рендере, управляет deps
  }, [store, enabled, ...deps]);

  return state;
}

export interface FileUrlState {
  url: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * object URL файла для <img src>, <video>, ссылки. Содержимое собирается один раз
 * и кешируется хранилищем, поэтому одна картинка в нескольких местах не качается заново.
 * URL не отзывается при размонтировании (он общий) — освобождайте store.release(id), когда файл больше не нужен.
 */
export function useFileUrl<M extends object>(
  store: FileStore<M>,
  file: StoredFile<M> | string | null | undefined,
): FileUrlState {
  const id = typeof file === 'string' ? file : (file?.id ?? null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const [state, setState] = useState<FileUrlState>({ url: null, loading: Boolean(id), error: null });

  useEffect(() => {
    if (!id || !fileRef.current) {
      setState({ url: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ url: null, loading: true, error: null });
    store.objectUrl(fileRef.current).then(
      (url) => !cancelled && setState({ url, loading: false, error: null }),
      (error: unknown) =>
        !cancelled &&
        setState({ url: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      cancelled = true;
    };
  }, [store, id]);

  return state;
}

export interface UploadTask {
  /** Локальный ключ задачи (не id файла) */
  key: string;
  name: string;
  size: number;
  /** 0..1 */
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  error: Error | null;
  /** id файла после успешной загрузки */
  fileId: string | null;
}

export interface UploadsApi<M extends object> {
  /** Текущие и завершившиеся с ошибкой загрузки (успешные убираются сами, если keepDone = false) */
  tasks: UploadTask[];
  uploading: boolean;
  /** Промис отклоняется при ошибке/отмене — но состояние задачи обновится в любом случае */
  upload(data: Blob | Uint8Array, opts?: Omit<UploadOptions<M>, 'onProgress' | 'signal'>): Promise<StoredFile<M>>;
  cancel(key: string): void;
  /** Убрать завершённые задачи (ошибки, отмены) из списка */
  dismiss(key?: string): void;
}

/**
 * Несколько параллельных загрузок с прогрессом и отменой.
 *
 *     const { upload, tasks } = useUpload(store);
 *     <input type="file" onChange={(e) => [...e.target.files!].forEach((f) => upload(f, { meta }))} />
 */
export function useUpload<M extends object>(store: FileStore<M>, { keepDone = false } = {}): UploadsApi<M> {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const seq = useRef(0);

  // Размонтировали посреди загрузки — отменяем, чтобы не оставлять полуфайлы
  useEffect(() => {
    const map = controllers.current;
    return () => map.forEach((c) => c.abort());
  }, []);

  const patch = useCallback((key: string, p: Partial<UploadTask>) => {
    setTasks((list) => list.map((t) => (t.key === key ? { ...t, ...p } : t)));
  }, []);

  const upload = useCallback<UploadsApi<M>['upload']>(
    async (data, opts = {}) => {
      const key = `u${++seq.current}`;
      const ctrl = new AbortController();
      controllers.current.set(key, ctrl);
      const name = opts.name ?? (data instanceof File ? data.name : 'file');
      const size = data instanceof Blob ? data.size : data.byteLength;
      setTasks((list) => [...list, { key, name, size, progress: 0, status: 'uploading', error: null, fileId: null }]);
      try {
        const file = await store.upload(data, {
          ...opts,
          signal: ctrl.signal,
          onProgress: (progress) => patch(key, { progress }),
        });
        if (keepDone) patch(key, { status: 'done', progress: 1, fileId: file.id });
        else setTasks((list) => list.filter((t) => t.key !== key));
        return file;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        patch(key, { status: ctrl.signal.aborted ? 'cancelled' : 'error', error });
        throw error;
      } finally {
        controllers.current.delete(key);
      }
    },
    [store, keepDone, patch],
  );

  const cancel = useCallback((key: string) => controllers.current.get(key)?.abort(), []);
  const dismiss = useCallback((key?: string) => {
    setTasks((list) => list.filter((t) => (key ? t.key !== key : t.status === 'uploading')));
  }, []);

  return { tasks, uploading: tasks.some((t) => t.status === 'uploading'), upload, cancel, dismiss };
}

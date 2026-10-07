import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { QueryConstraint } from 'firebase/firestore';
import type { FileStore, StoredFile, UploadOptions } from './store.ts';

/**
 * React bindings for FileStore: the `firestore-files/react` entry point.
 * Create the store once — outside the component or in useMemo.
 */

export interface FilesState<M extends object> {
  files: StoredFile<M>[];
  loading: boolean;
  error: Error | null;
}

/**
 * Complete files with live updates. Query constraints are an array created on every render,
 * so re-subscribing is driven by `deps`, as in useEffect.
 * `constraints = null` disables the subscription (e.g. while there is no taskId yet).
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
    // constraints is intentionally not a dependency: it is a new array on every render, deps drive it
  }, [store, enabled, ...deps]);

  return state;
}

export interface FileUrlState {
  url: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Object URL of a file for <img src>, <video>, a link. The content is assembled once and cached
 * by the store, so the same image in several places is not downloaded again.
 * The URL is not revoked on unmount (it is shared) — call store.release(id) when the file is no longer needed.
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
  /** Local task key (not the file id) */
  key: string;
  name: string;
  size: number;
  /** 0..1 */
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'cancelled';
  error: Error | null;
  /** File id after a successful upload */
  fileId: string | null;
}

export interface UploadsApi<M extends object> {
  /** Running and failed uploads (successful ones are removed automatically unless keepDone) */
  tasks: UploadTask[];
  uploading: boolean;
  /** The promise rejects on error/cancel — the task state is updated either way */
  upload(data: Blob | Uint8Array, opts?: Omit<UploadOptions<M>, 'onProgress' | 'signal'>): Promise<StoredFile<M>>;
  cancel(key: string): void;
  /** Remove finished tasks (errors, cancellations) from the list */
  dismiss(key?: string): void;
}

/**
 * Several parallel uploads with progress and cancellation.
 *
 *     const { upload, tasks } = useUpload(store);
 *     <input type="file" onChange={(e) => [...e.target.files!].forEach((f) => upload(f, { meta }))} />
 */
export function useUpload<M extends object>(store: FileStore<M>, { keepDone = false } = {}): UploadsApi<M> {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const seq = useRef(0);

  // Unmounted mid-upload — abort so no half-written files are left
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

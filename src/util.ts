/** Параллельно, но не больше limit задач одновременно; порядок результатов сохраняется */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true; // остальные воркеры не берут новые задачи
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Кеш собранных файлов с вытеснением самых старых по суммарному размеру */
export class BlobCache {
  private readonly entries = new Map<string, { blob: Promise<Blob>; size: number }>();
  private total = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(id: string): Promise<Blob> | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    // Перемещаем в конец — самый свежий
    this.entries.delete(id);
    this.entries.set(id, e);
    return e.blob;
  }

  set(id: string, blob: Promise<Blob>, size = 0) {
    this.delete(id);
    this.entries.set(id, { blob, size });
    this.total += size;
    this.evict();
  }

  setSize(id: string, size: number) {
    const e = this.entries.get(id);
    if (!e) return;
    this.total += size - e.size;
    e.size = size;
    this.evict();
  }

  delete(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    this.total -= e.size;
    this.entries.delete(id);
  }

  private evict() {
    for (const [id] of this.entries) {
      if (this.total <= this.maxBytes || this.entries.size <= 1) break;
      this.delete(id);
    }
  }
}

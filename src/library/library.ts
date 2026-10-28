/**
 * The model library: imported VRMs copied into Puppet's own storage, with
 * thumbnails, measured info and the user's favourites / names / times.
 */
import { readPath } from '../app/platform';
import { analyzeVrm } from './analyze';
import { createBackend, type LibraryBackend } from './backend';
import {
  IndexWriter,
  addEntry,
  markUsed,
  parseIndex,
  queryLibrary,
  reconcile,
  rename,
  setFavourite,
  type LibraryIndex,
  type LibraryItem,
  type LibraryQuery,
  type ModelInfo,
} from './libraryIndex';
import { readVrmMeta, summarizeLicence, type LicenceSummary } from './vrmMeta';

export interface Card extends LibraryItem {
  size: number;
  thumbUrl: string | null;
  licence: LicenceSummary;
}

export type ImportStep = 'reading' | 'checking' | 'rendering' | 'saving';
export interface ImportSource {
  name: string;
  /** Desktop: the file's path (copied by Rust). */
  path?: string;
  /** Browser / already-read bytes. */
  bytes?: ArrayBuffer;
}
export type ImportResult = { status: 'added' | 'duplicate'; id: string } | { status: 'error'; error: string };

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

const enc = new TextEncoder();

export class Library {
  readonly cards = new Map<string, Card>();
  index: LibraryIndex = parseIndex(null);
  onChange: () => void = () => {};
  private writer: IndexWriter;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly backend: LibraryBackend) {
    this.writer = new IndexWriter((json) => backend.saveIndex(json));
  }

  static async open(backend: LibraryBackend = createBackend()): Promise<Library> {
    const lib = new Library(backend);
    await lib.refresh();
    return lib;
  }

  /** Re-read storage, reconcile the index with it. */
  async refresh(): Promise<void> {
    const [stored, idxText] = await Promise.all([this.backend.list(), this.backend.loadIndex()]);
    this.index = parseIndex(idxText);
    const infos = new Map<string, { info: ModelInfo; size: number; hasThumb: boolean }>();
    for (const s of stored) {
      try {
        infos.set(s.id, { info: JSON.parse(s.meta) as ModelInfo, size: s.size, hasThumb: s.hasThumb });
      } catch {
        /* unreadable meta.json: treat as not imported */
      }
    }
    if (reconcile(this.index, infos.keys(), Date.now()) || idxText === null) this.save();
    for (const c of this.cards.values()) if (c.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
    this.cards.clear();
    await Promise.all(
      [...infos].map(async ([id, { info, size, hasThumb }]) => {
        const thumbUrl = hasThumb ? await this.thumbUrl(id).catch(() => null) : null;
        this.cards.set(id, { id, info, entry: this.index.entries[id], size, thumbUrl, licence: summarizeLicence(info.meta) });
      }),
    );
    this.onChange();
  }

  private async thumbUrl(id: string): Promise<string> {
    const png = await this.backend.read(id, 'thumb.png');
    return URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  }

  query(q: LibraryQuery): Card[] {
    return queryLibrary([...this.cards.values()], q) as Card[];
  }

  get size(): number {
    return this.cards.size;
  }

  save(): Promise<void> {
    return this.writer.save(this.index).catch((e) => console.warn('[library] index save failed', e));
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Imports run one at a time (each holds a whole model in memory). */
  import(src: ImportSource, onStep?: (s: ImportStep) => void): Promise<ImportResult> {
    const run = this.queue.then(() => this.importNow(src, onStep));
    this.queue = run.catch(() => {});
    return run;
  }

  private async importNow(src: ImportSource, onStep?: (s: ImportStep) => void): Promise<ImportResult> {
    try {
      onStep?.('reading');
      if (!/\.vrm$/i.test(src.name)) throw new Error('NOT A VRM (NEEDS A .VRM FILE)');
      const bytes = src.bytes ?? (src.path ? await readPath(src.path) : null);
      if (!bytes) throw new Error('NOTHING TO READ');
      onStep?.('checking');
      const meta = readVrmMeta(bytes);
      const id = await sha256Hex(bytes);
      if (this.cards.has(id)) return { status: 'duplicate', id };
      onStep?.('rendering');
      const { stats, thumb } = await analyzeVrm(bytes);
      onStep?.('saving');
      const info: ModelInfo = {
        infoVersion: 1,
        id,
        fileName: src.name.split(/[\\/]/).pop() ?? src.name,
        size: bytes.byteLength,
        spec: meta.spec,
        meta,
        stats,
        importedAt: Date.now(),
        sourcePath: src.path ?? null,
        thumbAt: thumb ? Date.now() : null,
      };
      // Model first, meta.json last: an entry only counts once meta.json exists.
      if (src.path && this.backend.importPath) await this.backend.importPath(src.path, id);
      else await this.backend.write(id, 'model.vrm', new Uint8Array(bytes));
      if (thumb) await this.backend.write(id, 'thumb.png', thumb);
      await this.backend.write(id, 'meta.json', enc.encode(JSON.stringify(info, null, 1)));
      const { entry } = addEntry(this.index, id, Date.now());
      await this.save();
      const thumbUrl = thumb ? URL.createObjectURL(new Blob([thumb as BlobPart], { type: 'image/png' })) : null;
      this.cards.set(id, { id, info, entry, size: bytes.byteLength, thumbUrl, licence: summarizeLicence(meta) });
      this.onChange();
      return { status: 'added', id };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      return { status: 'error', error: /NOT A VRM/.test(msg) ? msg : `FAILED: ${msg}` };
    }
  }

  async rerenderThumb(id: string): Promise<void> {
    const c = this.cards.get(id);
    if (!c) return;
    const bytes = await this.backend.read(id, 'model.vrm');
    const { thumb } = await analyzeVrm(bytes);
    if (!thumb) throw new Error('THUMBNAIL RENDER FAILED');
    await this.backend.write(id, 'thumb.png', thumb);
    c.info = { ...c.info, thumbAt: Date.now() };
    await this.backend.write(id, 'meta.json', enc.encode(JSON.stringify(c.info, null, 1)));
    if (c.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
    c.thumbUrl = URL.createObjectURL(new Blob([thumb as BlobPart], { type: 'image/png' }));
    this.onChange();
  }

  setFavourite(id: string, on: boolean): void {
    setFavourite(this.index, id, on);
    this.save();
    this.onChange();
  }

  rename(id: string, name: string): void {
    rename(this.index, id, name);
    this.save();
    this.onChange();
  }

  markUsed(id: string): void {
    markUsed(this.index, id, Date.now());
    this.save();
    this.onChange();
  }

  /** True the first time it is called for a model (then remembered). */
  takeNotice(id: string): boolean {
    const e = this.index.entries[id];
    if (!e || e.noticeSeen) return false;
    e.noticeSeen = true;
    this.save();
    return true;
  }

  async remove(id: string): Promise<void> {
    await this.backend.remove(id);
    const c = this.cards.get(id);
    if (c?.thumbUrl) URL.revokeObjectURL(c.thumbUrl);
    this.cards.delete(id);
    delete this.index.entries[id];
    await this.save();
    this.onChange();
  }

  readModel(id: string): Promise<ArrayBuffer> {
    return this.backend.read(id, 'model.vrm');
  }

  reveal(id: string): Promise<void> {
    return this.backend.reveal(id);
  }

  setMigrationDone(): void {
    this.index.migration = 'done';
    this.save();
  }
}

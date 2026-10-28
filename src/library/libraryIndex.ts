/**
 * The model library's index (`library.json`) and the card list logic: dedup,
 * favourites, search, sort, formatting. Pure: no DOM, no storage.
 *
 * Storage layout (see src/library/backend.ts):
 *   <appData>/library/library.json            this index
 *   <appData>/library/<sha256>/model.vrm      Puppet's own copy of the file
 *   <appData>/library/<sha256>/thumb.png      bust thumbnail
 *   <appData>/library/<sha256>/meta.json      ModelInfo (written last: marks the entry complete)
 */
import type { ModelWarning } from '../scene/modelChecks';
import type { VrmMeta, VrmSpec } from './vrmMeta';

export const LIBRARY_FILES = ['model.vrm', 'thumb.png', 'meta.json'] as const;
export type LibraryFile = (typeof LIBRARY_FILES)[number];

/** Library ids are the SHA-256 of the model file, lower-case hex. */
export const isValidId = (id: string): boolean => /^[0-9a-f]{64}$/.test(id);

export interface ModelStats {
  /** ARKit names matched (perfect sync is >= 40). */
  perfectSync: number;
  /** VRM preset expressions present, of 13. */
  presets: number;
  expressions: number;
  springChains: number;
  springJoints: number;
  /** Triangles across all meshes. */
  polygons: number;
  /** Model checks at import (src/scene/modelChecks.ts). Absent for models imported before they existed. */
  warnings?: ModelWarning[];
}

/** meta.json: what the importer measured. Immutable per file (the id is its hash). */
export interface ModelInfo {
  infoVersion: 1;
  id: string;
  fileName: string;
  size: number;
  spec: VrmSpec;
  meta: VrmMeta;
  stats: ModelStats;
  importedAt: number;
  sourcePath: string | null;
  thumbAt: number | null;
}

/** library.json: what the user changes. */
export interface IndexEntry {
  favourite: boolean;
  addedAt: number;
  lastUsedAt: number | null;
  customName: string | null;
  /** The one-time licence notice was shown for this model. */
  noticeSeen: boolean;
}

export interface LibraryIndex {
  version: 1;
  entries: Record<string, IndexEntry>;
  /** Offer to import the pre-library "last model" setting once. */
  migration: 'pending' | 'done';
}

export const emptyIndex = (): LibraryIndex => ({ version: 1, entries: {}, migration: 'pending' });

const num = (v: unknown, d: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Parse library.json leniently: bad entries are dropped, missing fields defaulted. */
export function parseIndex(text: string | null | undefined): LibraryIndex {
  const idx = emptyIndex();
  if (!text) return idx;
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return idx;
  }
  if (!raw || typeof raw !== 'object') return idx;
  if (raw.migration === 'done') idx.migration = 'done';
  const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [id, e] of Object.entries<any>(entries)) {
    if (!isValidId(id) || !e || typeof e !== 'object') continue;
    idx.entries[id] = {
      favourite: e.favourite === true,
      addedAt: num(e.addedAt, 0)!,
      lastUsedAt: num(e.lastUsedAt, null),
      customName: typeof e.customName === 'string' && e.customName.trim() ? e.customName.trim() : null,
      noticeSeen: e.noticeSeen === true,
    };
  }
  return idx;
}

export const serializeIndex = (idx: LibraryIndex): string => JSON.stringify(idx, null, 1);

/** Add a model by id. Dedup: an id already present keeps its entry (and added time). */
export function addEntry(idx: LibraryIndex, id: string, now: number): { entry: IndexEntry; added: boolean } {
  if (!isValidId(id)) throw new Error(`bad library id: ${id}`);
  const cur = idx.entries[id];
  if (cur) return { entry: cur, added: false };
  const entry: IndexEntry = { favourite: false, addedAt: now, lastUsedAt: null, customName: null, noticeSeen: false };
  idx.entries[id] = entry;
  return { entry, added: true };
}

/** Make the index match what is on disk: add entries for stored models, drop orphans. */
export function reconcile(idx: LibraryIndex, storedIds: Iterable<string>, now: number): boolean {
  const ids = new Set([...storedIds].filter(isValidId));
  let changed = false;
  for (const id of ids) if (addEntry(idx, id, now).added) changed = true;
  for (const id of Object.keys(idx.entries)) {
    if (!ids.has(id)) {
      delete idx.entries[id];
      changed = true;
    }
  }
  return changed;
}

export function setFavourite(idx: LibraryIndex, id: string, on: boolean): void {
  const e = idx.entries[id];
  if (e) e.favourite = on;
}

export function rename(idx: LibraryIndex, id: string, name: string): void {
  const e = idx.entries[id];
  if (e) e.customName = name.trim() ? name.trim().slice(0, 120) : null;
}

export function markUsed(idx: LibraryIndex, id: string, now: number): void {
  const e = idx.entries[id];
  if (e) e.lastUsedAt = now;
}

// ---------------------------------------------------------------- card list

export interface LibraryItem {
  id: string;
  entry: IndexEntry;
  info: ModelInfo;
}

export type LibraryFilter = 'all' | 'favourites';
export type LibrarySort = 'used' | 'name' | 'added';

export interface LibraryQuery {
  filter: LibraryFilter;
  search: string;
  sort: LibrarySort;
}

const stripExt = (f: string) => f.replace(/\.[^.]+$/, '');

export function displayName(item: Pick<LibraryItem, 'entry' | 'info'>): string {
  return item.entry.customName || item.info.meta.name || stripExt(item.info.fileName) || 'UNTITLED';
}

export function displayAuthor(info: ModelInfo): string {
  return info.meta.authors.join(', ');
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Filter, search and sort the cards. In ALL, favourites always come first. */
export function queryLibrary(items: readonly LibraryItem[], q: LibraryQuery): LibraryItem[] {
  const terms = fold(q.search).split(/\s+/).filter(Boolean);
  const out = items.filter((it) => {
    if (q.filter === 'favourites' && !it.entry.favourite) return false;
    if (!terms.length) return true;
    const hay = fold(`${displayName(it)} ${it.info.meta.name} ${displayAuthor(it.info)} ${it.info.fileName}`);
    return terms.every((t) => hay.includes(t));
  });
  const byName = (a: LibraryItem, b: LibraryItem) => fold(displayName(a)).localeCompare(fold(displayName(b))) || a.id.localeCompare(b.id);
  const cmp: Record<LibrarySort, (a: LibraryItem, b: LibraryItem) => number> = {
    // Never-used models go after used ones, newest import first among them.
    used: (a, b) => (b.entry.lastUsedAt ?? -1) - (a.entry.lastUsedAt ?? -1) || b.entry.addedAt - a.entry.addedAt || byName(a, b),
    name: byName,
    added: (a, b) => b.entry.addedAt - a.entry.addedAt || byName(a, b),
  };
  return out.sort((a, b) => (q.filter === 'all' ? Number(b.entry.favourite) - Number(a.entry.favourite) : 0) || cmp[q.sort](a, b));
}

// ---------------------------------------------------------------- formatting

export function formatAgo(t: number | null, now: number): string {
  if (t === null) return 'NEVER USED';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'JUST NOW';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} MIN AGO`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)} H AGO`;
  const d = h / 24;
  if (d < 2) return 'YESTERDAY';
  if (d < 30) return `${Math.floor(d)} DAYS AGO`;
  const mo = d / 30.44;
  if (mo < 12) return `${Math.floor(mo)} MO AGO`;
  return `${Math.floor(mo / 12)} Y AGO`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(1)}M`;
}

// ---------------------------------------------------------------- serialised saving

/**
 * Serialises index saves: at most one write in flight, and while one runs only
 * the newest pending document is kept. Every write is the whole document (the
 * backend writes it atomically: temp file + rename), so a crash leaves either
 * the old or the new index, never a mix, and saves never land out of order.
 */
export class IndexWriter {
  private pending: string | null = null;
  private running: Promise<void> | null = null;
  constructor(private write: (json: string) => Promise<void>) {}

  save(idx: LibraryIndex): Promise<void> {
    this.pending = serializeIndex(idx);
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  /** Resolves when everything queued so far is on disk. */
  flush(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending !== null) {
        const json = this.pending;
        this.pending = null;
        await this.write(json);
      }
    } finally {
      this.running = null;
    }
  }
}

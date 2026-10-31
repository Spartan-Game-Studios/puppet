/**
 * Library storage backends: the Rust commands in src-tauri/src/library.rs in
 * the desktop app, IndexedDB in a plain browser (`pnpm dev`, the headless test
 * harness). Both store the same files per entry (see libraryIndex.ts).
 */
import { isTauri } from '../app/platform';
import { t } from '../i18n';
import { isValidId, type LibraryFile } from './libraryIndex';

export interface StoredEntry {
  id: string;
  size: number;
  hasThumb: boolean;
  /** meta.json text. */
  meta: string;
}

export interface LibraryBackend {
  readonly kind: 'tauri' | 'indexeddb';
  location(): Promise<string>;
  list(): Promise<StoredEntry[]>;
  /** Desktop only: copy the user's file (no bytes through IPC). Returns false if already stored. */
  importPath?(path: string, id: string): Promise<boolean>;
  write(id: string, file: LibraryFile, bytes: Uint8Array): Promise<void>;
  read(id: string, file: LibraryFile): Promise<ArrayBuffer>;
  remove(id: string): Promise<void>;
  loadIndex(): Promise<string | null>;
  saveIndex(json: string): Promise<void>;
  /** Show the model file in the OS file manager (desktop only). */
  reveal(id: string): Promise<void>;
  openLink(which: string, url: string): Promise<void>;
}

async function invoke<T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args as any, options);
}

const check = (id: string) => {
  if (!isValidId(id)) throw new Error(`bad library id ${id}`);
};

class TauriBackend implements LibraryBackend {
  readonly kind = 'tauri' as const;
  location = () => invoke<string>('library_location');
  async list(): Promise<StoredEntry[]> {
    const l = await invoke<Array<{ id: string; size: number; has_thumb: boolean; meta: string }>>('library_list');
    return l.map((e) => ({ id: e.id, size: e.size, hasThumb: e.has_thumb, meta: e.meta }));
  }
  importPath = (path: string, id: string) => invoke<boolean>('library_import_path', { path, id });
  async write(id: string, file: LibraryFile, bytes: Uint8Array): Promise<void> {
    check(id);
    await invoke('library_write', bytes, { headers: { 'x-id': id, 'x-file': file } });
  }
  read = (id: string, file: LibraryFile) => invoke<ArrayBuffer>('library_read', { id, file });
  remove = (id: string) => invoke<void>('library_delete', { id });
  loadIndex = () => invoke<string | null>('library_index_load');
  saveIndex = (json: string) => invoke<void>('library_index_save', { json });
  reveal = (id: string) => invoke<void>('library_reveal', { id });
  openLink = (which: string) => invoke<void>('library_open_link', { which });
}

// ---------------------------------------------------------------- IndexedDB

const DB = 'puppet-library';
const FILES = 'files';
const KV = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error ?? new Error('aborted'));
  });
}

class IdbBackend implements LibraryBackend {
  readonly kind = 'indexeddb' as const;
  private db: Promise<IDBDatabase>;

  constructor() {
    this.db = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(FILES);
        r.result.createObjectStore(KV);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  async location(): Promise<string> {
    return `browser IndexedDB "${DB}"`;
  }

  async list(): Promise<StoredEntry[]> {
    const db = await this.db;
    const tx = db.transaction(FILES, 'readonly');
    const keys = (await req(tx.objectStore(FILES).getAllKeys())) as string[];
    const byId = new Map<string, Set<string>>();
    for (const k of keys) {
      const [id, f] = k.split('/');
      if (!isValidId(id)) continue;
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id)!.add(f);
    }
    const out: StoredEntry[] = [];
    for (const [id, files] of byId) {
      if (!files.has('model.vrm') || !files.has('meta.json')) continue;
      const t = db.transaction(FILES, 'readonly').objectStore(FILES);
      const [model, meta] = await Promise.all([req(t.get(`${id}/model.vrm`)) as Promise<Blob>, req(t.get(`${id}/meta.json`)) as Promise<Blob>]);
      out.push({ id, size: model.size, hasThumb: files.has('thumb.png'), meta: await meta.text() });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async write(id: string, file: LibraryFile, bytes: Uint8Array): Promise<void> {
    check(id);
    const db = await this.db;
    const tx = db.transaction(FILES, 'readwrite');
    tx.objectStore(FILES).put(new Blob([bytes as BlobPart]), `${id}/${file}`);
    await done(tx);
  }

  async read(id: string, file: LibraryFile): Promise<ArrayBuffer> {
    check(id);
    const db = await this.db;
    const b = (await req(db.transaction(FILES, 'readonly').objectStore(FILES).get(`${id}/${file}`))) as Blob | undefined;
    if (!b) throw new Error(`${file}: not in the library`);
    return b.arrayBuffer();
  }

  async remove(id: string): Promise<void> {
    check(id);
    const db = await this.db;
    const tx = db.transaction(FILES, 'readwrite');
    tx.objectStore(FILES).delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    await done(tx);
  }

  async loadIndex(): Promise<string | null> {
    const db = await this.db;
    return ((await req(db.transaction(KV, 'readonly').objectStore(KV).get('library.json'))) as string | undefined) ?? null;
  }

  /** One put in one transaction: IndexedDB commits it whole or not at all. */
  async saveIndex(json: string): Promise<void> {
    const db = await this.db;
    const tx = db.transaction(KV, 'readwrite');
    tx.objectStore(KV).put(json, 'library.json');
    await done(tx);
  }

  async reveal(): Promise<void> {
    throw new Error(t('library.err.revealDesktop'));
  }

  async openLink(_which: string, url: string): Promise<void> {
    window.open(url, '_blank', 'noopener');
  }
}

export function createBackend(): LibraryBackend {
  return isTauri ? new TauriBackend() : new IdbBackend();
}

/** Native multi-file open dialog (desktop). */
export async function pickVrmPaths(): Promise<string[]> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ multiple: true, directory: false, filters: [{ name: t('library.dialogFilter'), extensions: ['vrm'] }] });
  return Array.isArray(r) ? r : typeof r === 'string' ? [r] : [];
}

/** Browser multi-file picker. */
export function pickVrmFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vrm';
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/**
 * Storage for imported clips: the Rust commands in src-tauri/src/clips.rs in
 * the desktop app (`<appData>/clips/<sha256>/clip.fbx|clip.glb` plus an
 * atomically written `clips.json` index), IndexedDB in a plain browser.
 */
import { isTauri } from '../app/platform';
import type { UserClipEntry } from './catalog';

export type ClipExt = 'fbx' | 'glb';
export const isClipId = (id: string) => /^[0-9a-f]{64}$/.test(id);

export interface ClipBackend {
  readonly kind: 'tauri' | 'indexeddb';
  location(): Promise<string>;
  /** Desktop: copy the user's file (no bytes through IPC). Returns false if already stored. */
  importPath?(path: string, id: string, ext: ClipExt): Promise<boolean>;
  write(id: string, ext: ClipExt, bytes: Uint8Array): Promise<void>;
  read(id: string, ext: ClipExt): Promise<ArrayBuffer>;
  remove(id: string): Promise<void>;
  loadIndex(): Promise<UserClipEntry[]>;
  saveIndex(entries: UserClipEntry[]): Promise<void>;
}

async function invoke<T>(cmd: string, args?: unknown, options?: { headers: Record<string, string> }): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args as any, options);
}

const parseIndex = (s: string | null): UserClipEntry[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    const list = Array.isArray(v?.clips) ? v.clips : [];
    return list.filter((e: UserClipEntry) => e && typeof e.id === 'string' && isClipId(e.file) && (e.ext === 'fbx' || e.ext === 'glb'));
  } catch {
    return [];
  }
};
const indexJson = (entries: UserClipEntry[]) => JSON.stringify({ version: 1, clips: entries }, null, 1);

class TauriClips implements ClipBackend {
  readonly kind = 'tauri' as const;
  location = () => invoke<string>('clips_location');
  importPath = (path: string, id: string, ext: ClipExt) => invoke<boolean>('clips_import_path', { path, id, ext });
  async write(id: string, ext: ClipExt, bytes: Uint8Array): Promise<void> {
    await invoke('clips_write', bytes, { headers: { 'x-id': id, 'x-ext': ext } });
  }
  read = (id: string, ext: ClipExt) => invoke<ArrayBuffer>('clips_read', { id, ext });
  remove = (id: string) => invoke<void>('clips_delete', { id });
  loadIndex = async () => parseIndex(await invoke<string | null>('clips_index_load'));
  saveIndex = (e: UserClipEntry[]) => invoke<void>('clips_index_save', { json: indexJson(e) });
}

class IdbClips implements ClipBackend {
  readonly kind = 'indexeddb' as const;
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open('puppet-clips', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('files');
        r.result.createObjectStore('meta');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }
  private async tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = f(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  location = async () => 'browser IndexedDB (puppet-clips)';
  async write(id: string, ext: ClipExt, bytes: Uint8Array): Promise<void> {
    await this.tx('files', 'readwrite', (s) => s.put(bytes.slice().buffer, `${id}.${ext}`));
  }
  async read(id: string, ext: ClipExt): Promise<ArrayBuffer> {
    const v = await this.tx<ArrayBuffer | undefined>('files', 'readonly', (s) => s.get(`${id}.${ext}`));
    if (!v) throw new Error('clip file missing');
    return v;
  }
  async remove(id: string): Promise<void> {
    for (const ext of ['fbx', 'glb']) await this.tx('files', 'readwrite', (s) => s.delete(`${id}.${ext}`));
  }
  loadIndex = async () => parseIndex((await this.tx<string | undefined>('meta', 'readonly', (s) => s.get('index'))) ?? null);
  async saveIndex(e: UserClipEntry[]): Promise<void> {
    await this.tx('meta', 'readwrite', (s) => s.put(indexJson(e), 'index'));
  }
}

export const clipBackend = (): ClipBackend => (isTauri ? new TauriClips() : new IdbClips());

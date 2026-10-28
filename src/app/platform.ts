/**
 * Platform layer: the Tauri shell when running as the desktop app, browser
 * fallbacks otherwise (`pnpm dev` in a normal browser, the test harness).
 */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

const LS_KEY = 'puppet.settings';

export async function loadSettingsRaw(): Promise<string | null> {
  if (isTauri) return invoke<string | null>('load_settings');
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

export async function saveSettingsRaw(json: string): Promise<void> {
  if (isTauri) return invoke('save_settings', { json });
  try {
    localStorage.setItem(LS_KEY, json);
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

export async function settingsLocation(): Promise<string> {
  return isTauri ? invoke<string>('settings_location') : 'browser localStorage';
}

/** Native open dialog (Tauri). Returns a path, or null if cancelled / unavailable. */
export async function pickPath(name: string, extensions: string[]): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
  return typeof r === 'string' ? r : null;
}

/** Browser fallback picker: resolves to a File. */
export function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function readPath(path: string): Promise<ArrayBuffer> {
  if (!isTauri) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.arrayBuffer();
  }
  return invoke<ArrayBuffer>('read_file', { path });
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Native drag-and-drop gives real paths (Tauri). Returns an unlisten function. */
export async function onNativeDrop(cb: (paths: string[]) => void, hover: (on: boolean) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === 'over' || p.type === 'enter') hover(true);
    else if (p.type === 'leave') hover(false);
    else if (p.type === 'drop') {
      hover(false);
      cb(p.paths);
    }
  });
}

export interface VmcStats {
  enabled: boolean;
  target: string;
  frames: number;
  datagrams: number;
  bytes: number;
  errors: number;
  last_error: string | null;
}

export async function vmcConfigure(enabled: boolean, host: string, port: number): Promise<void> {
  if (!isTauri) return;
  await invoke('vmc_configure', { enabled, host, port });
}

export function vmcSend(frame: unknown): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return invoke('vmc_send', { frame });
}

export async function vmcStats(): Promise<VmcStats | null> {
  if (!isTauri) return null;
  return invoke<VmcStats>('vmc_stats');
}

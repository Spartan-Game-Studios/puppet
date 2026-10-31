/**
 * Platform layer: the Tauri shell when running as the desktop app, browser
 * fallbacks otherwise (`pnpm dev` in a normal browser, the test harness).
 */
import { t } from '../i18n';
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

/** Mirrors `vmc_in::InStatus`. */
export interface VmcInStatus {
  enabled: boolean;
  listening: string | null;
  error: string | null;
  packets: number;
  messages: number;
  ignored: number;
  bad: number;
  sender: string | null;
  age_ms: number | null;
  rate: number;
}

export function vmcInConfigure(enabled: boolean, port: number, lan: boolean): Promise<VmcInStatus | null> {
  if (!isTauri) return Promise.resolve(null);
  return invoke<VmcInStatus>('vmc_in_configure', { enabled, port, lan });
}

export async function vmcInStatus(): Promise<VmcInStatus | null> {
  return isTauri ? invoke<VmcInStatus>('vmc_in_status') : null;
}

export function vmcInPoll(since: number): Promise<import('../vmc/vmcInput').VmcInFrame | null> {
  if (!isTauri) return Promise.resolve(null);
  return invoke('vmc_in_poll', { since });
}

// ---------------------------------------------------------------- demo (src-tauri/src/demo.rs)

/** Mirrors `demo::Status`. `demo` is false in the full app. */
export interface DemoStatus {
  demo: boolean;
  used_s: number;
  limit_s: number;
  locked: boolean;
  /** Hours used up; when not `locked` yet, the app locks at its next start. */
  expired: boolean;
  steam: boolean;
}

/** In the browser `?demo=on|low|expired|locked` fakes a demo build (layout tests). */
function fakeDemo(): DemoStatus {
  const m = new URLSearchParams(location.search).get('demo');
  const limit = 100 * 3600;
  const used = m === 'locked' || m === 'expired' ? limit : m === 'low' ? limit - 4 * 3600 : 0;
  return {
    demo: ['on', 'low', 'expired', 'locked'].includes(m ?? ''),
    used_s: used,
    limit_s: limit,
    locked: m === 'locked',
    expired: used >= limit,
    steam: false,
  };
}

export async function demoStatus(): Promise<DemoStatus> {
  return isTauri ? invoke<DemoStatus>('demo_status') : fakeDemo();
}

export async function demoHeartbeat(): Promise<DemoStatus> {
  return isTauri ? invoke<DemoStatus>('demo_heartbeat') : fakeDemo();
}

export async function demoBuy(): Promise<void> {
  if (isTauri) return invoke('demo_buy');
  window.open('https://store.steampowered.com/search/?term=VPuppet', '_blank');
}

/** PUPPET_QUERY env var (desktop app only): extra query parameters for testing. */
export async function devQuery(): Promise<string> {
  return isTauri ? invoke<string>('dev_query') : '';
}

export function debugLog(line: string): void {
  if (isTauri) invoke('debug_log', { line }).catch(() => {});
  else console.log('[vpuppet]', line);
}

/** A URL the <video> element can load: as-is in a browser; a blob of the file's bytes in the app. */
export async function mediaUrl(src: string): Promise<string> {
  if (!isTauri || /^(https?:|blob:|data:)/.test(src)) return src;
  const buf = await readPath(src);
  const type = src.endsWith('.webm') ? 'video/webm' : 'video/mp4';
  return URL.createObjectURL(new Blob([buf], { type }));
}

// ---------------------------------------------------------------- virtual camera

export type VcamState = 'unavailable' | 'needs_setup' | 'needs_approval' | 'ready' | 'running' | 'error';

/** Mirrors `vcam::SinkStatus` in src-tauri/src/vcam/mod.rs. */
export interface VcamStatus {
  sink: string;
  state: VcamState;
  detail: string;
  hint: string | null;
  command: string | null;
  action: string | null;
  devices: string[];
  device: string | null;
  format: 'bgra' | 'yuyv' | 'bgr24' | null;
}

/** Mirrors `vcam::VcamStats`. */
export interface VcamRustStats {
  running: boolean;
  width: number;
  height: number;
  format: string | null;
  received: number;
  written: number;
  dropped: number;
  rejected: number;
  write_errors: number;
  last_error: string | null;
  bytes: number;
  fps_in: number;
  fps_out: number;
  copy_ms: number;
  write_ms: number;
  max_gap_ms: number;
}

const BROWSER_VCAM: VcamStatus = {
  sink: 'browser',
  state: 'unavailable',
  detail: t('stage.desktopOnly'),
  hint: t('stage.vcamBrowserHint'),
  command: null,
  action: null,
  devices: [],
  device: null,
  format: null,
};

export async function vcamStatus(): Promise<VcamStatus> {
  return isTauri ? invoke<VcamStatus>('vcam_status') : BROWSER_VCAM;
}

export async function vcamStats(): Promise<VcamRustStats | null> {
  return isTauri ? invoke<VcamRustStats>('vcam_stats') : null;
}

export async function vcamSetup(): Promise<void> {
  if (isTauri) await invoke('vcam_setup');
}

/** Mirrors `vcam::ExtState` in src-tauri/src/vcam/mod.rs. */
export type VcamExtState =
  | 'unavailable'
  | 'not_installed'
  | 'working'
  | 'awaiting_approval'
  | 'active'
  | 'needs_update'
  | 'needs_reboot'
  | 'uninstalling'
  | 'failed';

/** Mirrors `vcam::ExtensionStatus`: the macOS camera extension (null on other OSes). */
export interface VcamExtStatus {
  state: VcamExtState;
  detail: string;
  installed_version: string | null;
  bundled_version: string | null;
  install: string | null;
  can_uninstall: boolean;
  open_settings: boolean;
}

export async function vcamExtStatus(): Promise<VcamExtStatus | null> {
  return isTauri ? invoke<VcamExtStatus | null>('vcam_ext_status') : null;
}

export async function vcamExtInstall(): Promise<void> {
  if (isTauri) await invoke('vcam_ext_install');
}

export async function vcamExtUninstall(): Promise<void> {
  if (isTauri) await invoke('vcam_ext_uninstall');
}

export async function vcamExtOpenSettings(): Promise<void> {
  if (isTauri) await invoke('vcam_ext_open_settings');
}

export async function vcamSelectDevice(device: string | null): Promise<void> {
  if (isTauri) await invoke('vcam_select_device', { device });
}

export async function vcamStart(width: number, height: number, fps: number): Promise<void> {
  if (isTauri) await invoke('vcam_start', { width, height, fps });
}

export async function vcamStop(): Promise<void> {
  if (isTauri) await invoke('vcam_stop');
}

/** One frame as a raw binary IPC body (header + BGRA); no JSON, no base64. */
export async function vcamFrame(bytes: Uint8Array): Promise<void> {
  if (!isTauri) return;
  const { invoke: inv } = await import('@tauri-apps/api/core');
  await inv('vcam_frame', bytes);
}

/**
 * System-wide hotkeys (desktop app): tauri-plugin-global-shortcut, so emote
 * and expression keys work while another app (OBS, a game) has focus.
 *
 * macOS: registered through Carbon's RegisterEventHotKey, which needs no
 * Accessibility permission; a registered combo is taken from every other app
 * while VPuppet runs, so prefer combos with a modifier. A combo another app
 * already owns fails to register and is reported; the in-window key still
 * works.
 */
import { isTauri } from '../app/platform';
import { t } from '../i18n';

export interface GlobalResult {
  registered: string[];
  failed: Array<{ accelerator: string; error: string }>;
}

type Handler = (accelerator: string, state: 'Pressed' | 'Released') => void;

let current: string[] = [];

export async function setGlobalShortcuts(accelerators: string[], handler: Handler): Promise<GlobalResult> {
  const res: GlobalResult = { registered: [], failed: [] };
  if (!isTauri) {
    if (accelerators.length) res.failed.push(...accelerators.map((a) => ({ accelerator: a, error: t('motion.hk.desktopOnly') })));
    return res;
  }
  const gs = await import('@tauri-apps/plugin-global-shortcut');
  if (current.length) {
    await gs.unregister(current).catch(() => {});
    current = [];
  }
  for (const acc of [...new Set(accelerators)]) {
    try {
      await gs.register(acc, (e) => handler(acc, e.state));
      current.push(acc);
      res.registered.push(acc);
    } catch (e) {
      res.failed.push({ accelerator: acc, error: String(e) });
    }
  }
  return res;
}

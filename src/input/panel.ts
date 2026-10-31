/** 08 HOTKEYS panel: bindings list, rebinding, global toggle, gamepad status. */
import { defaultBindings, findConflicts, formatTrigger, modeLabel, newBindingId, type Action, type Binding, type Trigger } from './bindings';
import type { HotkeyManager } from './hotkeys';
import type { ExpressionMode } from '../anim/expressions';
import { t } from '../i18n';

export interface HotkeyPanelContext {
  host: HTMLElement;
  hotkeys: HotkeyManager;
  bindings: () => Binding[];
  setBindings: (b: Binding[]) => void;
  global: () => boolean;
  setGlobal: (on: boolean) => void;
  /** Emote clips: [id, label]. */
  emotes: () => Array<[string, string]>;
  /** Expression names on the current model. */
  expressions: () => string[];
  modelHash: () => string | null;
}

const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function actionValue(a: Action): string {
  if (a.kind === 'emote') return `emote:${a.clip}`;
  if (a.kind === 'expression') return `expr:${a.name}`;
  return a.kind;
}

export function mountHotkeyPanel(ctx: HotkeyPanelContext): { render: () => void; flash: (id: string) => void; status: () => void } {
  const { host } = ctx;
  host.innerHTML = `
    <h2><span class="idx">08</span>${t('motion.hk.title')}</h2>
    <label class="check"><input type="checkbox" id="hk-global" /><span>${t('motion.hk.global')}</span></label>
    <div class="hk-status" id="hk-global-status"></div>
    <div class="row"><span class="lbl">${t('motion.hk.gamepad')}</span><span class="val" id="hk-pad">${t('motion.hk.padNone')}</span></div>
    <div class="hk-head"><span>${t('motion.hk.colTrigger')}</span><span>${t('motion.hk.colAction')}</span><span>${t('motion.hk.colMode')}</span><span title="${esc(t('motion.hk.colModelTitle'))}">${t('motion.hk.colModel')}</span><span></span></div>
    <div class="hk-list" id="hk-list"></div>
    <div class="row btns">
      <button class="btn" id="hk-add">${t('motion.hk.add')}</button>
      <button class="btn ghost" id="hk-defaults" title="${esc(t('motion.hk.defaultsTitle'))}">${t('motion.hk.defaults')}</button>
    </div>
    <p class="note mute">${t('motion.hk.note')}</p>`;
  const list = host.querySelector<HTMLElement>('#hk-list')!;
  const globalCb = host.querySelector<HTMLInputElement>('#hk-global')!;
  globalCb.checked = ctx.global();
  globalCb.addEventListener('change', () => ctx.setGlobal(globalCb.checked));

  const save = (b: Binding[]) => {
    ctx.setBindings(b);
    render();
  };

  function actionOptions(sel: string): string {
    const opt = (v: string, l: string) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`;
    const emotes = ctx.emotes().map(([id, l]) => opt(`emote:${id}`, `▶ ${l}`)).join('');
    const exprs = ctx.expressions().map((n) => opt(`expr:${n}`, `◐ ${n.toUpperCase()}`)).join('');
    let extra = '';
    if (!sel.startsWith('emote:') && !sel.startsWith('expr:') && sel !== 'reset' && sel !== 'picker' && sel !== 'camera') extra = opt(sel, sel);
    else if (sel.startsWith('expr:') && !ctx.expressions().includes(sel.slice(5))) extra = opt(sel, `◐ ${t('motion.hk.notOnModel', { name: sel.slice(5).toUpperCase() })}`);
    else if (sel.startsWith('emote:') && !ctx.emotes().some(([id]) => `emote:${id}` === sel)) extra = opt(sel, `▶ ${t('motion.hk.missing', { name: sel.slice(6) })}`);
    return `${extra}<optgroup label="${esc(t('motion.hk.emotes'))}">${emotes}</optgroup><optgroup label="${esc(t('motion.hk.expressions'))}">${exprs}</optgroup>${opt('reset', `■ ${t('motion.act.reset')}`)}${opt('picker', `▣ ${t('motion.act.picker')}`)}${opt('camera', `● ${t('motion.act.camera')}`)}`;
  }

  function render(): void {
    const all = ctx.bindings();
    const model = ctx.modelHash();
    const conflicts = findConflicts(all, model);
    const clash = new Map<string, string>();
    for (const c of conflicts) for (const id of c.ids) clash.set(id, c.app ? t('motion.hk.shadows', { app: c.app }) : t('motion.hk.sameTrigger', { n: c.ids.filter((x) => x !== id).length }));
    list.innerHTML = '';
    const shown = all.filter((b) => !b.model || b.model === model);
    for (const b of shown) {
      const row = document.createElement('div');
      row.className = `hk-row${b.model ? ' model' : ''}`;
      row.dataset.id = b.id;
      const isExpr = b.action.kind === 'expression';
      const label = b.trigger.kind === 'key' && !b.trigger.code ? '—' : formatTrigger(b.trigger, mac);
      row.innerHTML = `<button class="trig${clash.has(b.id) ? ' clash' : ''}" title="${esc(clash.get(b.id) ?? t('motion.hk.rebindTitle'))}">${esc(label)}</button>
        <select class="act">${actionOptions(actionValue(b.action))}</select>
        <select class="mode"${isExpr ? '' : ' disabled'}>${(['toggle', 'on', 'momentary'] as ExpressionMode[]).map((m) => `<option value="${m}"${isExpr && (b.action as { mode: string }).mode === m ? ' selected' : ''}>${esc(modeLabel(m))}</option>`).join('')}</select>
        <input type="checkbox" class="mdl" title="${esc(t('motion.hk.mdlTitle'))}"${b.model ? ' checked' : ''}${model ? '' : ' disabled'} />
        <button class="x" title="${esc(t('motion.hk.removeTitle'))}">×</button>`;
      const trig = row.querySelector<HTMLButtonElement>('.trig')!;
      trig.addEventListener('click', () => {
        if (ctx.hotkeys.capturing) return;
        trig.classList.add('listen');
        trig.textContent = t('motion.hk.press');
        ctx.hotkeys.captureNext((trg: Trigger) => {
          if (trg.kind === 'key' && !trg.code) return render();
          save(ctx.bindings().map((x) => (x.id === b.id ? { ...x, trigger: trg } : x)));
        });
      });
      row.querySelector<HTMLSelectElement>('.act')!.addEventListener('change', (e) => {
        const v = (e.target as HTMLSelectElement).value;
        let action: Action;
        if (v.startsWith('emote:')) action = { kind: 'emote', clip: v.slice(6) };
        else if (v.startsWith('expr:')) action = { kind: 'expression', name: v.slice(5), mode: isExpr ? (b.action as { mode: ExpressionMode }).mode : 'toggle', fadeIn: 0.15, fadeOut: 0.3 };
        else action = { kind: v as 'reset' | 'picker' | 'camera' };
        save(ctx.bindings().map((x) => (x.id === b.id ? { ...x, action } : x)));
      });
      row.querySelector<HTMLSelectElement>('.mode')!.addEventListener('change', (e) => {
        const mode = (e.target as HTMLSelectElement).value as ExpressionMode;
        save(ctx.bindings().map((x) => (x.id === b.id && x.action.kind === 'expression' ? { ...x, action: { ...x.action, mode } } : x)));
      });
      row.querySelector<HTMLInputElement>('.mdl')!.addEventListener('change', (e) => {
        const on = (e.target as HTMLInputElement).checked;
        save(ctx.bindings().map((x) => (x.id === b.id ? { ...x, model: on ? (model ?? undefined) : undefined } : x)));
      });
      row.querySelector<HTMLButtonElement>('.x')!.addEventListener('click', () => save(ctx.bindings().filter((x) => x.id !== b.id)));
      list.append(row);
    }
    if (!shown.length) list.innerHTML = `<span class="empty-note">${esc(t('motion.hk.empty'))}</span>`;
    status();
  }

  host.querySelector('#hk-add')!.addEventListener('click', () => {
    const b: Binding = { id: newBindingId(), trigger: { kind: 'key', code: '' }, action: { kind: 'reset' } };
    save([...ctx.bindings(), b]);
    (list.querySelector(`[data-id="${b.id}"] .trig`) as HTMLButtonElement | null)?.click();
  });
  host.querySelector('#hk-defaults')!.addEventListener('click', () => {
    // Keep this model's own bindings; replace the global set.
    save([...ctx.bindings().filter((b) => b.model), ...defaultBindings()]);
  });

  function status(): void {
    const st = host.querySelector<HTMLElement>('#hk-global-status')!;
    const g = ctx.hotkeys.globalStatus;
    if (!ctx.global()) st.textContent = t('motion.hk.stOff');
    else if (g.failed.length && !g.registered.length) st.textContent = t('motion.hk.stUnavailable', { error: g.failed[0].error.toUpperCase() });
    else
      st.textContent = g.failed.length
        ? t('motion.hk.stGlobalTaken', { n: g.registered.length, failed: g.failed.length, keys: g.failed.map((f) => f.accelerator).join(' ') })
        : t('motion.hk.stGlobal', { n: g.registered.length });
    st.classList.toggle('err', ctx.global() && g.failed.length > 0);
    host.querySelector('#hk-pad')!.textContent = ctx.hotkeys.gamepad.pads.length ? ctx.hotkeys.gamepad.pads[0].toUpperCase().slice(0, 40) : t('motion.hk.padNone');
  }

  function flash(id: string): void {
    const row = list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.add('fired');
    setTimeout(() => row.classList.remove('fired'), 250);
  }

  render();
  return { render, flash, status };
}

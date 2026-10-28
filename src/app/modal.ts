/**
 * The one modal component: every settings window on the stage (SCENE, FACE,
 * PHYSICS, MOTION, HOTKEYS, LIP SYNC, VMC, MODEL INFO) is a clone of
 * #tpl-modal (index.html). It docks to the right of the stage so the avatar
 * stays in view while you change things.
 *
 * - Esc, the close button, a click on the backdrop or gamepad B close it.
 * - Tab / Shift+Tab are trapped inside it.
 * - Focus returns to whatever opened it (normally its top-bar button).
 * - One open at a time: opening another closes the current one.
 */
import { cloneTpl } from './ui';

export interface ModalOptions {
  id: string;
  /** Short index shown in accent before the title (the shortcut letter). */
  idx: string;
  title: string;
  /** Nodes moved into the body. */
  content?: Iterable<Node>;
  /** Button(s) that open it: they get .on / aria-expanded while it is open. */
  buttons?: HTMLElement[];
  onOpen?: () => void;
  onClose?: () => void;
}

export interface Modal {
  readonly id: string;
  readonly el: HTMLDialogElement;
  readonly body: HTMLElement;
  /** Free slot in the header (e.g. a badge). */
  readonly extra: HTMLElement;
  readonly isOpen: boolean;
  show(opener?: HTMLElement | null): void;
  close(): void;
  toggle(opener?: HTMLElement | null): void;
}

let current: Modal | null = null;
const all = new Map<string, Modal>();

/** The open modal, if any. */
export function openModal(): Modal | null {
  return current?.isOpen ? current : null;
}
export function getModal(id: string): Modal | undefined {
  return all.get(id);
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), summary';

/** Focusable elements inside `root` that are actually shown. */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert], .hidden, [hidden]'));
}

export function createModal(o: ModalOptions): Modal {
  const el = cloneTpl<HTMLDialogElement>('tpl-modal');
  el.id = o.id;
  el.setAttribute('aria-labelledby', `${o.id}-title`);
  el.querySelector('.idx')!.textContent = o.idx;
  const title = el.querySelector<HTMLElement>('.pm-title')!;
  title.textContent = o.title;
  title.id = `${o.id}-title`;
  const body = el.querySelector<HTMLElement>('.pm-body')!;
  const extra = el.querySelector<HTMLElement>('.pm-extra')!;
  if (o.content) body.append(...o.content);
  document.body.append(el);
  let opener: HTMLElement | null = null;
  const buttons = o.buttons ?? [];
  for (const b of buttons) {
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
  }

  const m: Modal = {
    id: o.id,
    el,
    body,
    extra,
    get isOpen() {
      return el.open;
    },
    show(from) {
      if (el.open) return;
      if (current && current !== m) current.close();
      opener = from ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
      el.showModal();
      finished = false;
      current = m;
      for (const b of buttons) {
        b.classList.add('on');
        b.setAttribute('aria-expanded', 'true');
      }
      body.scrollTop = 0;
      // The first control inside (not the close button), else the close button.
      const f = focusables(body)[0] ?? el.querySelector<HTMLElement>('.pm-close');
      f?.focus({ preventScroll: true });
      o.onOpen?.();
    },
    close() {
      if (!el.open) return;
      el.close();
      finish(); // now, not on the queued 'close' event: the next key must see no modal
    },
    toggle(from) {
      if (el.open) m.close();
      else m.show(from);
    },
  };

  let finished = true;
  el.addEventListener('close', () => finish());
  function finish(): void {
    if (finished) return;
    finished = true;
    if (current === m) current = null;
    for (const b of buttons) {
      b.classList.remove('on');
      b.setAttribute('aria-expanded', 'false');
    }
    const back = opener;
    opener = null;
    if (back?.isConnected && back.getClientRects().length) back.focus({ preventScroll: true });
    else if (el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    o.onClose?.();
  }
  // Esc: close through our path (focus return), never the browser's default.
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    m.close();
  });
  el.querySelector('.pm-close')!.addEventListener('click', () => m.close());
  // A press on the backdrop (outside the box) closes.
  el.addEventListener('mousedown', (e) => {
    if (e.target !== el) return;
    const r = el.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) m.close();
  });
  // Focus trap.
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = focusables(el);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i === f.length - 1 ? 0 : i + 1;
    e.preventDefault();
    f[next].focus();
  });
  for (const b of buttons) b.addEventListener('click', () => m.toggle(b));
  all.set(o.id, m);
  return m;
}

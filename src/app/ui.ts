/**
 * Small reusable stage components, each cloned from a <template> in
 * index.html so the markup lives in one place:
 *
 *   #tpl-badge  makeBadge()        square one-letter badge (licence type, model-check marker)
 *   #tpl-csec   mountCardSection() collapsible section of the camera card (header button + body)
 *
 * The modal (#tpl-modal) is in modal.ts.
 */

export function cloneTpl<T extends Element = HTMLElement>(id: string): T {
  const tpl = document.getElementById(id) as HTMLTemplateElement | null;
  if (!tpl) throw new Error(`missing template #${id}`);
  return tpl.content.firstElementChild!.cloneNode(true) as T;
}

export type BadgeTone = 'warn' | 'ok' | 'info' | 'unknown';

/** A square badge: one letter, a tone, and the full meaning as its tooltip. */
export function makeBadge(letter: string, tone: BadgeTone, title: string): HTMLElement {
  const el = cloneTpl('tpl-badge');
  el.textContent = letter;
  el.classList.add(tone);
  el.title = title;
  el.setAttribute('aria-label', title);
  return el;
}

export interface CardSection {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly open: boolean;
  setOpen(on: boolean): void;
  /** Short text on the right of the header (e.g. ON / OFF). */
  setState(text: string, hot?: boolean): void;
}

/**
 * Replace a `.csec-mount` placeholder (data-csec, data-idx, data-title,
 * optional data-key) with a #tpl-csec section and move its children into the
 * body. `onToggle` persists the open state.
 */
export function mountCardSection(mount: HTMLElement, open: boolean, onToggle: (open: boolean) => void): CardSection {
  const el = cloneTpl('tpl-csec');
  const head = el.querySelector<HTMLButtonElement>('.csec-head')!;
  const body = el.querySelector<HTMLElement>('.csec-body')!;
  const state = el.querySelector<HTMLElement>('.csec-state')!;
  el.dataset.csec = mount.dataset.csec ?? '';
  el.querySelector('.idx')!.textContent = mount.dataset.idx ?? '';
  el.querySelector('.csec-title')!.textContent = mount.dataset.title ?? '';
  head.title = `${open ? 'Collapse' : 'Expand'} ${mount.dataset.title ?? ''}`.trim();
  body.id = `csec-${el.dataset.csec}`;
  head.setAttribute('aria-controls', body.id);
  body.append(...mount.childNodes);
  mount.replaceWith(el);
  const sec: CardSection = {
    el,
    body,
    get open() {
      return !el.classList.contains('closed');
    },
    setOpen(on) {
      el.classList.toggle('closed', !on);
      head.setAttribute('aria-expanded', String(on));
      head.title = `${on ? 'Collapse' : 'Expand'} ${mount.dataset.title ?? ''}`.trim();
    },
    setState(text, hot = false) {
      state.textContent = text;
      state.classList.toggle('hot', hot);
    },
  };
  sec.setOpen(open);
  head.addEventListener('click', () => {
    sec.setOpen(!sec.open);
    onToggle(sec.open);
  });
  return sec;
}

/**
 * On-screen picker: a grid of emotes and expressions over the stage, opened
 * with a hotkey (G / pad RB by default), driven by arrows or d-pad / left
 * stick, Enter or A to fire, Esc or B to close. Mouse works too.
 */
import type { NavDir } from './gamepad';
import type { PickerControl } from './hotkeys';
import { t } from '../i18n';

export interface PickerItem {
  label: string;
  group: 'EMOTE' | 'EXPRESSION' | 'IDLE' | '';
  run: () => void;
  /** Shown highlighted (playing / held). */
  active?: () => boolean;
}

const COLS = 4;

/** Group ids stay English; this is what the tile shows. */
const GROUP_LABEL = (g: PickerItem['group']): string =>
  g === 'EMOTE' ? t('motion.pick.emote') : g === 'EXPRESSION' ? t('motion.pick.expression') : g === 'IDLE' ? t('motion.pick.idle') : '';

export class Picker implements PickerControl {
  private el: HTMLElement;
  private grid: HTMLElement;
  private items: PickerItem[] = [];
  private index = 0;
  open = false;

  constructor(host: HTMLElement, private build: () => PickerItem[]) {
    this.el = document.createElement('div');
    this.el.className = 'picker hidden';
    this.el.setAttribute('role', 'dialog');
    this.el.innerHTML = `<div class="picker-box"><div class="picker-head"><span><span class="idx">▣</span> ${t('motion.pick.title')}</span><span class="picker-keys">${t('motion.pick.keys')}</span></div><div class="picker-grid"></div></div>`;
    this.grid = this.el.querySelector('.picker-grid')!;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    host.appendChild(this.el);
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    this.items = this.build();
    this.index = Math.min(this.index, Math.max(0, this.items.length - 1));
    this.render();
    this.open = true;
    this.el.classList.remove('hidden');
  }

  close(): void {
    this.open = false;
    this.el.classList.add('hidden');
  }

  nav(dir: NavDir): void {
    const n = this.items.length;
    if (!n) return;
    const d = { left: -1, right: 1, up: -COLS, down: COLS }[dir];
    let i = this.index + d;
    if (dir === 'left' || dir === 'right') i = (i + n) % n;
    else if (i < 0 || i >= n) i = Math.max(0, Math.min(n - 1, i));
    this.index = i;
    this.render();
  }

  select(): void {
    const it = this.items[this.index];
    if (!it) return;
    it.run();
    this.render();
  }

  private render(): void {
    this.grid.innerHTML = '';
    this.items.forEach((it, i) => {
      const b = document.createElement('button');
      b.className = `picker-item${i === this.index ? ' sel' : ''}${it.active?.() ? ' on' : ''}`;
      b.innerHTML = `<small>${GROUP_LABEL(it.group)}</small><span>${it.label}</span>`;
      b.addEventListener('click', () => {
        this.index = i;
        this.select();
      });
      this.grid.append(b);
    });
    (this.grid.children[this.index] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }
}

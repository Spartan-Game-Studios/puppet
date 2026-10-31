/**
 * The Steam demo's face (the clock itself is src-tauri/src/demo.rs): a DEMO
 * cell in the bottom bar with the hours left, a banner on HOME near and after
 * the end, and the lock card over the stage once the 100 hours are used.
 *
 *   const demo = await mountDemo({ stageActive, onLock })
 *
 * In the full app `demo_status` says `demo: false` and nothing is mounted.
 * While `stageActive()` (a model on the stage, HOME closed) it sends a
 * heartbeat every HEARTBEAT_MS, which is what counts as use. When the clock
 * runs out `onLock` fires once: main.ts stops the camera, VMC and the virtual
 * camera. HOME keeps working (browse, import, rename, remove, reveal the
 * files), so nothing the user imported is lost.
 */
import './demo.css';
import { demoBuy, demoHeartbeat, demoStatus, type DemoStatus } from './platform';
import { t } from '../i18n';

const HEARTBEAT_MS = 5000;
/** Show the HOME banner from this many hours left. */
const WARN_H = 10;

export interface DemoDeps {
  stageActive: () => boolean;
  onLock: () => void;
  /** LIBRARY on the lock card. */
  showLibrary: () => void;
}

export interface Demo {
  readonly locked: boolean;
  /** Bring the lock card forward (a model load was refused). */
  nudge: () => void;
}

const hoursLeft = (s: DemoStatus) => Math.max(0, (s.limit_s - s.used_s) / 3600);
const fmtLeft = (s: DemoStatus) => {
  const h = hoursLeft(s);
  return h >= 1 ? t('demo.hoursLeft', { n: Math.floor(h) }) : t('demo.minutesLeft', { n: Math.ceil(h * 60) });
};

export async function mountDemo(deps: DemoDeps): Promise<Demo> {
  let st = await demoStatus().catch(() => null);
  if (!st?.demo) return { locked: false, nudge: () => {} };

  // Bottom bar: DEMO 87H LEFT (click: buy).
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'cell demo-cell';
  cell.title = t('demo.cellTitle');
  cell.innerHTML = `<span class="lbl">${t('demo.cell')}</span><span class="val"></span>`;
  cell.addEventListener('click', () => demoBuy());
  document.getElementById('status')?.parentElement?.before(cell);

  // HOME banner (low time, or ended).
  const banner = document.createElement('div');
  banner.className = 'demo-banner hidden';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `<span class="demo-msg"></span><button type="button" class="btn accent demo-buy">${t('demo.buy')}</button>`;
  document.querySelector('#home .home-bar')?.after(banner);

  // Lock card over the stage.
  const lock = document.createElement('div');
  lock.className = 'demo-lock hidden';
  lock.id = 'demo-lock';
  lock.innerHTML = `
    <div class="demo-card" role="alertdialog" aria-labelledby="demo-lock-title">
      <h2 id="demo-lock-title"><span class="idx">!</span>${t('demo.lockTitle')}</h2>
      <p>${t('demo.lockUsed')}</p>
      <p>${t('demo.lockKept')}</p>
      <div class="row btns">
        <button type="button" class="btn accent demo-buy">${t('demo.buy')}</button>
        <button type="button" class="btn ghost demo-lib">${t('demo.library')}</button>
      </div>
    </div>`;
  document.getElementById('stage')?.append(lock);

  for (const b of document.querySelectorAll<HTMLButtonElement>('.demo-buy')) b.addEventListener('click', () => demoBuy());
  lock.querySelector('.demo-lib')!.addEventListener('click', () => deps.showLibrary());

  let locked = false;
  function render(s: DemoStatus): void {
    st = s;
    // Used up mid-session (expired, not locked): this session keeps going; the next start locks.
    const lastSession = s.expired && !s.locked;
    (cell.querySelector('.val') as HTMLElement).textContent = s.locked ? t('demo.ended') : lastSession ? t('demo.lastSession') : fmtLeft(s);
    cell.classList.toggle('hot', s.expired || hoursLeft(s) <= WARN_H);
    const warn = s.expired || hoursLeft(s) <= WARN_H;
    banner.classList.toggle('hidden', !warn);
    banner.classList.toggle('ended', s.expired);
    (banner.querySelector('.demo-msg') as HTMLElement).textContent = s.locked
      ? t('demo.bannerEnded')
      : lastSession
        ? t('demo.bannerExpired')
        : t('demo.bannerLeft', { left: fmtLeft(s) });
    lock.classList.toggle('hidden', !s.locked);
    if (s.locked && !locked) {
      locked = true;
      deps.onLock();
    }
  }
  render(st);

  setInterval(() => {
    if (locked) return;
    (deps.stageActive() ? demoHeartbeat() : demoStatus()).then(render).catch(() => {});
  }, HEARTBEAT_MS);

  return {
    get locked() {
      return locked;
    },
    nudge() {
      banner.classList.remove('flash');
      void banner.offsetWidth; // restart the animation
      banner.classList.add('flash');
    },
  };
}

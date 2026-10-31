/**
 * HOME: the model library screen. The first screen at launch and reachable
 * any time (L or Esc from the stage, the HOME button). Static layout is in
 * index.html (#home, #tpl-card, #home-confirm); this file fills and binds it.
 *
 * Also owns the stage's library bits: the bottom bar's model name, licence
 * letter badge and model-check marker, the MODEL INFO modal (I, or a click on
 * the name) and the one-time licence notice for restricted models.
 */
import './home.css';
import { baseName, isTauri, readPath } from './platform';
import { t } from '../i18n';
import { pickVrmFiles, pickVrmPaths } from '../library/backend';
import { Library, type Card, type ImportResult, type ImportSource, type ImportStep } from '../library/library';
import { displayAuthor, displayName, formatBytes, formatCount, tn, type LibraryQuery } from '../library/libraryIndex';
import { badgeLabel, LICENCE_LETTER, licenceLetterTitle, readVrmMeta, summarizeLicence, type LicenceSummary, type VrmMeta } from '../library/vrmMeta';
import { buildCard, CARD_WARNINGS, renderLicence, renderWarnings, syncLabel } from './homeView';
import { getModal } from './modal';
import { makeBadge } from './ui';
import type { ModelWarning } from '../scene/modelChecks';

export interface HomeDeps {
  /** Load bytes onto the stage (main.ts loadModel). Resolves true on success. */
  loadModel(buf: ArrayBuffer, label: string, path: string | null): Promise<boolean>;
  setStatus(s: string, err?: boolean): void;
  /** The pre-library "last model" setting, for the one-time import offer. */
  lastModelPath: string | null;
  /** Called after the screen switches (the stage canvas needs a resize). */
  onShow?(home: boolean): void;
  /** Card menu → MODEL DOCTOR (src/app/doctorUi.ts). */
  openDoctor?(id: string): void;
}

export interface Home {
  readonly library: Library;
  readonly visible: boolean;
  show(on: boolean): void;
  /** main.ts: a model is now on the stage (from a card, O, a drop or ?model=). */
  /** `warnings`: rest-pose model checks from loadAvatar (shown in MODEL INFO). */
  modelLoaded(hash: string, buf: ArrayBuffer, label: string, path: string | null, warnings?: ModelWarning[]): void;
  importPaths(paths: string[]): Promise<void>;
  importFiles(files: File[]): Promise<void>;
  setDropHover(on: boolean): void;
  /** Keyboard: returns true when the home screen consumed the key. */
  handleKey(e: KeyboardEvent): boolean;
  toggleModelInfo(force?: boolean): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STEP_TEXT: Record<ImportStep, () => string> = {
  reading: () => t('library.step.reading'),
  checking: () => t('library.step.checking'),
  rendering: () => t('library.step.rendering'),
  saving: () => t('library.step.saving'),
};

export async function mountHome(deps: HomeDeps): Promise<Home> {
  const library = await Library.open();
  const grid = $('home-grid');
  const tpl = $<HTMLTemplateElement>('tpl-card');
  const search = $<HTMLInputElement>('home-search');
  const sortSel = $<HTMLSelectElement>('home-sort');
  const confirmDlg = $<HTMLDialogElement>('home-confirm');

  const q: LibraryQuery = { filter: 'all', search: '', sort: 'used' };
  let visible = false;
  let focusId: string | null = null;
  let stageId: string | null = null;
  let stageMeta: { meta: VrmMeta; summary: LicenceSummary; card: Card | null; warnings: ModelWarning[] } | null = null;
  let shown: Card[] = [];
  /** Which card has which drawer open ('lic' | 'menu'), kept across re-renders. */
  const drawers = new Map<string, 'lic' | 'menu'>();

  // ---------------------------------------------------------------- render
  function render(): void {
    const now = Date.now();
    const all = [...library.cards.values()];
    const favs = all.filter((c) => c.entry.favourite).length;
    $('home-count').textContent = all.length ? `[${all.length}]` : '';
    $('home-n-all').textContent = String(all.length);
    $('home-n-fav').textContent = String(favs);
    segSet();
    shown = library.query(q);
    const hadFocus = grid.contains(document.activeElement);
    grid.innerHTML = '';
    for (const c of shown) {
      const el = buildCard(tpl, c, now, c.id === stageId);
      const d = drawers.get(c.id);
      if (d) el.classList.add(d === 'lic' ? 'lic-open' : 'menu-open');
      grid.append(el);
    }
    $('home-empty').classList.toggle('hidden', all.length > 0);
    $('home-nomatch').classList.toggle('hidden', all.length === 0 || shown.length > 0);
    if (!focusId || !shown.some((c) => c.id === focusId)) focusId = shown[0]?.id ?? null;
    setRoving(hadFocus);
    $('home-esc').classList.toggle('mute', !stageId);
  }

  function cardEl(id: string | null): HTMLElement | null {
    return id ? grid.querySelector<HTMLElement>(`.card[data-id="${id}"]`) : null;
  }

  function setRoving(focus: boolean): void {
    grid.querySelectorAll<HTMLElement>('.card').forEach((el) => (el.tabIndex = el.dataset.id === focusId ? 0 : -1));
    if (focus) cardEl(focusId)?.focus({ preventScroll: false });
  }

  function focusCard(id: string | null): void {
    if (!id) return;
    focusId = id;
    setRoving(true);
    cardEl(id)?.scrollIntoView({ block: 'nearest' });
  }

  function segSet(): void {
    $('home-filter')
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => {
        b.classList.toggle('on', b.dataset.value === q.filter);
        b.setAttribute('aria-checked', String(b.dataset.value === q.filter));
      });
  }

  library.onChange = () => {
    render();
    refreshStageHeader();
  };

  // ---------------------------------------------------------------- show / hide
  function show(on: boolean): void {
    visible = on;
    document.body.classList.toggle('on-home', on);
    if (on) {
      render();
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement) cardEl(focusId)?.focus({ preventScroll: true });
      });
    } else {
      drawers.clear();
      ($('btn-home') as HTMLElement).blur();
    }
    deps.onShow?.(on);
  }

  // ---------------------------------------------------------------- load onto stage
  async function loadCard(id: string): Promise<void> {
    const c = library.cards.get(id);
    if (!c) return;
    deps.setStatus(t('library.status.loading', { name: displayName(c) }));
    try {
      const buf = await library.readModel(id);
      show(false);
      await deps.loadModel(buf, displayName(c), null);
    } catch (e) {
      deps.setStatus(t('library.status.libraryErr', { msg: (e as Error).message }), true);
    }
  }

  // ---------------------------------------------------------------- import
  interface Row {
    li: HTMLElement;
    state: HTMLElement;
  }
  let importing = 0;
  let importStats = { added: 0, dup: 0, err: 0 };

  function importRow(name: string): Row {
    const panel = $('home-imports');
    if (importing === 0 && panel.classList.contains('hidden')) {
      $('home-import-list').innerHTML = '';
      importStats = { added: 0, dup: 0, err: 0 };
    }
    panel.classList.remove('hidden');
    const li = document.createElement('li');
    li.className = 'queued';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = name;
    n.title = name;
    const state = document.createElement('span');
    state.className = 's';
    state.textContent = t('library.import.queued');
    li.append(n, state);
    $('home-import-list').append(li);
    li.scrollIntoView({ block: 'nearest' });
    return { li, state };
  }

  function importSummary(): void {
    const { added, dup, err } = importStats;
    const parts = [importing ? t('library.import.left', { n: importing }) : t('library.import.done'), t('library.import.sumAdded', { n: added })];
    if (dup) parts.push(t('library.import.sumDup', { n: dup }));
    if (err) parts.push(t('library.import.sumFailed', { n: err }));
    $('home-import-sum').textContent = ` · ${parts.join(' · ')}`;
  }

  async function runImports(srcs: ImportSource[]): Promise<ImportResult[]> {
    if (!srcs.length) return [];
    const rows = srcs.map((s) => importRow(s.name));
    importing += srcs.length;
    importSummary();
    const results = await Promise.all(
      srcs.map(async (s, i) => {
        const row = rows[i];
        const r = await library.import(s, (step) => {
          row.li.className = 'busy';
          row.state.textContent = STEP_TEXT[step]();
        });
        importing--;
        if (r.status === 'error') {
          importStats.err++;
          row.li.className = 'err';
          row.state.textContent = r.error;
          row.state.title = r.error;
        } else {
          if (r.status === 'added') importStats.added++;
          else importStats.dup++;
          row.li.className = r.status === 'added' ? 'ok' : 'dup';
          row.state.textContent = r.status === 'added' ? t('library.import.added') : t('library.import.dup');
          focusId = r.id;
        }
        importSummary();
        return r;
      }),
    );
    if (visible) {
      render();
      focusCard(focusId);
    }
    return results;
  }

  async function importDialog(): Promise<void> {
    if (isTauri) {
      const paths = await pickVrmPaths();
      await home.importPaths(paths);
    } else {
      await home.importFiles(await pickVrmFiles());
    }
  }

  // ---------------------------------------------------------------- card actions
  function toggleFav(id: string): void {
    const c = library.cards.get(id);
    if (!c) return;
    library.setFavourite(id, !c.entry.favourite);
    focusCard(id);
  }

  function toggleDrawer(id: string, which: 'lic' | 'menu'): void {
    drawers.get(id) === which ? drawers.delete(id) : drawers.set(id, which);
    const el = cardEl(id);
    el?.classList.toggle('lic-open', drawers.get(id) === 'lic');
    el?.classList.toggle('menu-open', drawers.get(id) === 'menu');
    if (drawers.get(id) === 'menu') el?.querySelector<HTMLElement>('.menu .act')?.focus();
  }

  function startRename(id: string): void {
    const el = cardEl(id);
    const c = library.cards.get(id);
    if (!el || !c) return;
    drawers.delete(id);
    el.classList.remove('menu-open', 'lic-open');
    const nameEl = el.querySelector<HTMLElement>('.name')!;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename';
    input.value = displayName(c);
    input.placeholder = c.info.meta.name || c.info.fileName;
    input.title = t('library.renameTitle');
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() !== displayName(c)) library.rename(id, input.value);
      else render();
      focusCard(id);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  let confirmId: string | null = null;
  function askRemove(id: string): void {
    const c = library.cards.get(id);
    if (!c) return;
    confirmId = id;
    $('home-confirm-text').textContent = t('library.confirmText', { name: displayName(c), size: formatBytes(c.size) });
    confirmDlg.showModal();
  }
  $('btn-confirm-cancel').addEventListener('click', () => confirmDlg.close());
  $('btn-confirm-ok').addEventListener('click', async () => {
    confirmDlg.close();
    const id = confirmId;
    confirmId = null;
    if (!id) return;
    const idx = shown.findIndex((c) => c.id === id);
    const next = shown[idx + 1]?.id ?? shown[idx - 1]?.id ?? null;
    try {
      await library.remove(id);
      deps.setStatus(t('library.status.removed'));
      focusCard(next);
    } catch (e) {
      deps.setStatus(t('library.status.removeFailed', { msg: (e as Error).message }), true);
    }
  });
  confirmDlg.addEventListener('close', () => {
    if (visible) focusCard(focusId);
  });

  async function act(id: string, what: string): Promise<void> {
    if (what === 'load') return loadCard(id);
    if (what === 'rename') return startRename(id);
    if (what === 'remove') return askRemove(id);
    if (what === 'doctor') {
      drawers.delete(id);
      render();
      return deps.openDoctor?.(id);
    }
    if (what === 'thumb') {
      const el = cardEl(id);
      el?.classList.add('busy');
      deps.setStatus(t('library.step.rendering'));
      try {
        await library.rerenderThumb(id);
        deps.setStatus(t('library.status.thumbUpdated'));
      } catch (e) {
        deps.setStatus(t('library.status.thumbErr', { msg: (e as Error).message }), true);
      }
      drawers.delete(id);
      render();
      focusCard(id);
      return;
    }
    if (what === 'reveal') {
      try {
        await library.reveal(id);
      } catch (e) {
        deps.setStatus(String((e as Error).message ?? e).toUpperCase(), true);
      }
    }
  }

  grid.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const el = t.closest<HTMLElement>('.card');
    if (!el || t.closest('input')) return;
    const id = el.dataset.id!;
    focusId = id;
    setRoving(false);
    if (t.closest('.star')) toggleFav(id);
    else if (t.closest('.lic-toggle')) toggleDrawer(id, 'lic');
    else if (t.closest('.more')) toggleDrawer(id, 'menu');
    else if (t.closest('.close-drawer')) {
      drawers.delete(id);
      el.classList.remove('lic-open', 'menu-open');
      el.focus();
    } else if (t.closest('[data-act]')) act(id, t.closest<HTMLElement>('[data-act]')!.dataset.act!);
    // A single click only selects; loading is USE MODEL, a double click or Enter.
  });
  grid.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    const el = t.closest<HTMLElement>('.card');
    if (!el || t.closest('input, button, .drawer')) return;
    loadCard(el.dataset.id!);
  });
  grid.addEventListener('focusin', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.card');
    if (el && el.dataset.id !== focusId) {
      focusId = el.dataset.id!;
      grid.querySelectorAll<HTMLElement>('.card').forEach((c) => (c.tabIndex = c === el ? 0 : -1));
    }
  });

  // ---------------------------------------------------------------- toolbar
  $('home-filter').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.value) {
      q.filter = b.dataset.value as LibraryQuery['filter'];
      render();
    }
  });
  search.addEventListener('input', () => {
    q.search = search.value;
    render();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      if (search.value) {
        search.value = '';
        q.search = '';
        render();
      }
      cardEl(focusId)?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      focusCard(focusId ?? shown[0]?.id ?? null);
    }
  });
  sortSel.addEventListener('change', () => {
    q.sort = sortSel.value as LibraryQuery['sort'];
    render();
  });
  $('btn-home-clear').addEventListener('click', () => {
    q.filter = 'all';
    q.search = search.value = '';
    render();
  });
  $('btn-import').addEventListener('click', () => importDialog());
  $('btn-imports-close').addEventListener('click', () => $('home-imports').classList.add('hidden'));
  $('btn-home').addEventListener('click', () => show(!visible || !stageId ? true : false));
  // Help links: the desktop app opens them in the system browser (fixed list in Rust).
  $('home-empty').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-link]');
    if (!a || !isTauri) return;
    e.preventDefault();
    library.backend.openLink(a.dataset.link!, a.href).catch((err) => deps.setStatus(t('library.status.link', { msg: String(err) }), true));
  });

  // ---------------------------------------------------------------- migration (pre-library last model)
  const lastPath = deps.lastModelPath;
  if (library.index.migration === 'pending') {
    const known = lastPath && [...library.cards.values()].some((c) => c.info.sourcePath === lastPath);
    if (lastPath && !known) {
      $('home-migrate-name').textContent = baseName(lastPath);
      $('home-migrate-name').title = lastPath;
      $('home-migrate').classList.remove('hidden');
    } else library.setMigrationDone();
  }
  $('btn-migrate-yes').addEventListener('click', async () => {
    $('home-migrate').classList.add('hidden');
    library.setMigrationDone();
    if (!lastPath) return;
    const name = baseName(lastPath);
    if (isTauri) await runImports([{ name, path: lastPath }]);
    else {
      try {
        await runImports([{ name, bytes: await readPath(lastPath) }]);
      } catch (e) {
        deps.setStatus(t('library.status.lastModel', { msg: (e as Error).message }), true);
      }
    }
  });
  $('btn-migrate-no').addEventListener('click', () => {
    $('home-migrate').classList.add('hidden');
    library.setMigrationDone();
  });

  // ---------------------------------------------------------------- stage: bottom bar, model info, notice
  /** Serious model-check warnings (the ones the library card shows too). */
  const serious = (w: ModelWarning[]) => w.filter((x) => CARD_WARNINGS.has(x.code));

  function refreshStageHeader(): void {
    if (!stageId || !stageMeta) return;
    const c = library.cards.get(stageId) ?? null;
    stageMeta.card = c;
    if (c) $('model-name').textContent = displayName(c);
    const s = stageMeta.summary;
    const letter = makeBadge(LICENCE_LETTER[s.badge], s.tone, licenceLetterTitle(s.badge));
    letter.classList.add('lic-letter');
    $('model-lic').replaceChildren(letter);
    const bad = serious(stageMeta.warnings);
    $('model-warn').replaceChildren(...(bad.length ? [makeBadge('!', 'warn', t('library.checks.badge', { list: bad.map((w) => w.text).join(' · ') }))] : []));
    const btn = $<HTMLButtonElement>('btn-model-info');
    btn.disabled = false;
    btn.title = bad.length
      ? t('library.info.titleWarn', { badge: badgeLabel(s.badge), headline: s.headline, warns: tn('library.info.warns', bad.length) })
      : t('library.info.title', { badge: badgeLabel(s.badge), headline: s.headline });
    const m = getModal('model-info');
    if (m) m.extra.replaceChildren(makeBadge(LICENCE_LETTER[s.badge], s.tone, licenceLetterTitle(s.badge)));
    renderModelInfo();
  }

  function renderModelInfo(): void {
    if (!stageMeta) return;
    const body = $('model-info-body');
    body.innerHTML = '';
    const { meta, summary, card } = stageMeta;
    const facts: Array<[string, string]> = [
      [t('library.fact.name'), card ? displayName(card) : meta.name || '-'],
      [t('library.lic.author'), card ? displayAuthor(card.info) || '-' : meta.authors.join(', ') || '-'],
      ['VRM', meta.spec],
    ];
    if (card) {
      const st = card.info.stats;
      facts.push([t('library.fact.expressions'), syncLabel(st).text]);
      facts.push([t('library.fact.springBones'), t('library.fact.springValue', { chains: st.springChains, joints: st.springJoints })]);
      facts.push([t('library.fact.triangles'), formatCount(st.polygons)]);
      facts.push([t('library.fact.file'), `${card.info.fileName} · ${formatBytes(card.size)}`]);
    }
    const dl = document.createElement('dl');
    dl.className = 'mi-facts';
    for (const [k, v] of facts) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dd.title = v;
      row.append(dt, dd);
      dl.append(row);
    }
    const lic = document.createElement('div');
    lic.className = 'lic-body';
    renderLicence(lic, summary, meta);
    body.append(dl);
    if (stageMeta.warnings.length) body.append(renderWarnings(stageMeta.warnings));
    body.append(lic);
  }

  function toggleModelInfo(force?: boolean): void {
    const m = getModal('model-info');
    if (!m) return;
    const on = force ?? !m.isOpen;
    if (on && !stageMeta) return;
    if (on) {
      hideNotice();
      m.show($('btn-model-info'));
      $('btn-model-info').classList.add('on');
    } else m.close();
  }
  $('btn-model-info').addEventListener('click', () => toggleModelInfo());
  getModal('model-info')?.el.addEventListener('close', () => $('btn-model-info').classList.remove('on'));

  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  function hideNotice(): void {
    $('lic-notice').classList.add('hidden');
    if (noticeTimer) clearTimeout(noticeTimer);
  }
  function showNotice(s: LicenceSummary, name: string): void {
    $('lic-notice-badge').textContent = badgeLabel(s.badge);
    $('lic-notice-text').textContent = [name ? t('library.notice.name', { name }) : '', s.headline, t('library.notice.body')]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    $('lic-notice').classList.remove('hidden');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, 20000);
  }
  $('btn-lic-notice-ok').addEventListener('click', hideNotice);
  $('btn-lic-notice-info').addEventListener('click', () => toggleModelInfo(true));

  // ---------------------------------------------------------------- keyboard
  function columns(): number {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (!visible) return false;
    if (confirmDlg.open) return true;
    const k = e.key;
    const i = shown.findIndex((c) => c.id === focusId);
    const move = (to: number) => {
      e.preventDefault();
      if (!shown.length) return;
      focusCard(shown[Math.max(0, Math.min(shown.length - 1, to))].id);
    };
    const inCardButton = (e.target as HTMLElement).closest?.('.card button');
    if (k === 'ArrowRight') move(i + 1);
    else if (k === 'ArrowLeft') move(i - 1);
    else if (k === 'ArrowDown') move(i < 0 ? 0 : i + columns());
    else if (k === 'ArrowUp') {
      if (i - columns() < 0) {
        e.preventDefault();
        search.focus();
      } else move(i - columns());
    } else if (k === 'Home') move(0);
    else if (k === 'End') move(shown.length - 1);
    else if (k === 'Enter' && !inCardButton) {
      e.preventDefault();
      if (focusId) loadCard(focusId);
    } else if (k === ' ' && inCardButton) return true; // let the button click
    else if (k === 'Escape') {
      e.preventDefault();
      if (focusId && drawers.has(focusId)) {
        drawers.delete(focusId);
        render();
        focusCard(focusId);
      } else if (stageId) show(false);
    } else if (k === 's' || k === 'S') {
      e.preventDefault();
      if (focusId) toggleFav(focusId);
    } else if (k === 'l' || k === 'L') {
      e.preventDefault();
      if (focusId) toggleDrawer(focusId, 'lic');
    } else if (k === 'F2') {
      e.preventDefault();
      if (focusId) startRename(focusId);
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      if (focusId) askRemove(focusId);
    } else if (k === '/') {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (k === 'i' || k === 'I' || k === 'o' || k === 'O') {
      e.preventDefault();
      importDialog();
    } else if (k === 'Tab') return false;
    // Everything else is swallowed: stage shortcuts make no sense on this screen.
    return true;
  }

  // ---------------------------------------------------------------- public
  const home: Home = {
    library,
    get visible() {
      return visible;
    },
    show,
    modelLoaded(hash, buf, label, path, warnings = []) {
      stageId = hash;
      let meta: VrmMeta | null = null;
      try {
        meta = readVrmMeta(buf);
      } catch {
        /* loaded fine but no readable meta: no licence panel */
      }
      if (!meta) {
        stageMeta = null;
        $<HTMLButtonElement>('btn-model-info').disabled = true;
        $('model-lic').replaceChildren();
        $('model-warn').replaceChildren();
        getModal('model-info')?.close();
        return;
      }
      const summary = summarizeLicence(meta);
      stageMeta = { meta, summary, card: library.cards.get(hash) ?? null, warnings };
      hideNotice();
      refreshStageHeader();
      const existing = library.cards.get(hash);
      if (existing) {
        if (summary.restricted && library.takeNotice(hash)) showNotice(summary, displayName(existing));
        library.markUsed(hash);
        return;
      }
      // New model opened from the stage (O / drop / ?model=): show the notice now
      // (first time by definition), import it into the library in the background.
      if (summary.restricted) showNotice(summary, meta.name || label);
      const src: ImportSource = isTauri && path ? { name: baseName(path), path } : { name: /\.vrm$/i.test(label) ? label : `${label}.vrm`, bytes: buf };
      runImports([src]).then(([r]) => {
        if (r?.status === 'added' || r?.status === 'duplicate') {
          if (summary.restricted) library.takeNotice(r.id);
          library.markUsed(r.id);
          refreshStageHeader();
        }
      });
    },
    async importPaths(paths) {
      const vrms = paths.filter(Boolean);
      await runImports(vrms.map((p) => ({ name: baseName(p), path: p })));
    },
    async importFiles(files) {
      const srcs: ImportSource[] = [];
      for (const f of files) srcs.push({ name: f.name, bytes: await f.arrayBuffer() });
      await runImports(srcs);
    },
    setDropHover(on) {
      $('home-drop').classList.toggle('on', on && visible);
    },
    handleKey,
    toggleModelInfo,
  };

  if (!isTauri) {
    // Browser drops onto the home screen (the desktop app gets native drops via main.ts).
    const homeEl = $('home');
    homeEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      home.setDropHover(true);
    });
    homeEl.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !homeEl.contains(e.relatedTarget as Node)) home.setDropHover(false);
    });
    homeEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      home.setDropHover(false);
      home.importFiles(Array.from(e.dataTransfer?.files ?? []));
    });
  }

  render();
  return home;
}

import { describe, expect, it } from 'vitest';
import { clean, parseVrmMeta, readGlbJson, readVrmMeta, summarizeLicence, vrmSpecOf } from '../src/library/vrmMeta';
import {
  IndexWriter,
  addEntry,
  displayName,
  emptyIndex,
  formatAgo,
  formatBytes,
  formatCount,
  isValidId,
  markUsed,
  parseIndex,
  queryLibrary,
  reconcile,
  rename,
  serializeIndex,
  setFavourite,
  type LibraryItem,
  type ModelInfo,
} from '../src/library/libraryIndex';

// ---------------------------------------------------------------- synthetic fixtures (no real models)

const vrm1 = (meta: Record<string, unknown>) => ({ asset: { version: '2.0' }, extensions: { VRMC_vrm: { specVersion: '1.0', meta } } });
const vrm0 = (meta: Record<string, unknown>) => ({ asset: { version: '2.0' }, extensions: { VRM: { exporterVersion: 'test', meta } } });

/** A minimal GLB: header + JSON chunk (no BIN chunk). */
function glb(json: unknown): ArrayBuffer {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = new TextEncoder().encode(text);
  const buf = new ArrayBuffer(20 + body.length);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, buf.byteLength, true);
  dv.setUint32(12, body.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buf, 20).set(body);
  return buf;
}

const FULL_1 = {
  name: 'Test Girl',
  version: '2.1',
  authors: ['Alice', 'Bob'],
  copyrightInformation: '(c) Alice',
  contactInformation: 'alice@example.com',
  references: ['Base mesh X'],
  thirdPartyLicenses: 'Hair: CC-BY',
  licenseUrl: 'https://vrm.dev/licenses/1.0/',
  otherLicenseUrl: 'https://example.com/terms',
  avatarPermission: 'everyone',
  commercialUsage: 'corporation',
  allowExcessivelyViolentUsage: true,
  allowExcessivelySexualUsage: false,
  allowPoliticalOrReligiousUsage: false,
  allowAntisocialOrHateUsage: false,
  creditNotation: 'required',
  allowRedistribution: true,
  modification: 'allowModification',
};

describe('VRM meta: 1.0', () => {
  it('reads every field', () => {
    const m = parseVrmMeta(vrm1(FULL_1));
    expect(m.spec).toBe('1.0');
    expect(m.name).toBe('Test Girl');
    expect(m.version).toBe('2.1');
    expect(m.authors).toEqual(['Alice', 'Bob']);
    expect(m.copyright).toBe('(c) Alice');
    expect(m.contact).toBe('alice@example.com');
    expect(m.references).toEqual(['Base mesh X']);
    expect(m.thirdPartyLicenses).toBe('Hair: CC-BY');
    expect(m.licenseUrl).toBe('https://vrm.dev/licenses/1.0/');
    expect(m.otherLicenseUrl).toBe('https://example.com/terms');
    expect(m.avatarPermission).toBe('everyone');
    expect(m.commercialUsage).toBe('corporation');
    expect(m.allowViolent).toBe(true);
    expect(m.allowSexual).toBe(false);
    expect(m.allowPolitical).toBe(false);
    expect(m.allowAntisocial).toBe(false);
    expect(m.creditNotation).toBe('required');
    expect(m.allowRedistribution).toBe(true);
    expect(m.modification).toBe('allowModification');
  });

  it('treats literal "undefined" strings as empty', () => {
    const m = parseVrmMeta(vrm1({ name: 'undefined', version: 'undefined', authors: ['undefined'], avatarPermission: 'onlyAuthor' }));
    expect(m.name).toBe('');
    expect(m.version).toBe('');
    expect(m.authors).toEqual([]);
    expect(m.avatarPermission).toBe('onlyAuthor');
    expect(clean(' null ')).toBe('');
    expect(clean(3)).toBe('3');
  });

  it('missing / invalid fields are null, not guessed', () => {
    const m = parseVrmMeta(vrm1({ avatarPermission: 'whoever', commercialUsage: 7, allowRedistribution: 'yes' }));
    expect(m.avatarPermission).toBeNull();
    expect(m.commercialUsage).toBeNull();
    expect(m.allowRedistribution).toBeNull();
    expect(m.creditNotation).toBeNull();
  });
});

describe('VRM meta: 0.x', () => {
  it('maps the 0.x fields (including the "Ussage" spellings) onto 1.0 terms', () => {
    const m = parseVrmMeta(
      vrm0({
        title: 'Old Boy',
        version: '1.0',
        author: 'Carol',
        contactInformation: 'carol.example',
        reference: 'none',
        allowedUserName: 'ExplicitlyLicensedPerson',
        violentUssageName: 'Disallow',
        sexualUssageName: 'Allow',
        commercialUssageName: 'Allow',
        licenseName: 'CC_BY_ND',
        otherPermissionUrl: '',
        otherLicenseUrl: 'https://example.com/l',
      }),
    );
    expect(m.spec).toBe('0.x');
    expect(m.name).toBe('Old Boy');
    expect(m.authors).toEqual(['Carol']);
    expect(m.references).toEqual(['none']);
    expect(m.avatarPermission).toBe('onlySeparatelyLicensedPerson');
    expect(m.allowViolent).toBe(false);
    expect(m.allowSexual).toBe(true);
    expect(m.commercialUsage).toBe('personalProfit');
    expect(m.licenseName).toBe('CC_BY_ND');
    expect(m.creditNotation).toBe('required');
    expect(m.modification).toBe('prohibited');
    expect(m.allowPolitical).toBeNull();
  });

  it('OnlyAuthor / Disallow', () => {
    const m = parseVrmMeta(vrm0({ allowedUserName: 'OnlyAuthor', commercialUssageName: 'Disallow', licenseName: 'Redistribution_Prohibited' }));
    expect(m.avatarPermission).toBe('onlyAuthor');
    expect(m.commercialUsage).toBe('personalNonProfit');
    expect(m.allowRedistribution).toBe(false);
  });

  it('reads VRoid Hub licence URLs', () => {
    const url =
      'https://hub.vroid.com/license?allowed_to_use_user=everyone&corporate_commercial_use=disallow&credit=necessary&modification=disallow&personal_commercial_use=disallow&redistribution=disallow&version=1';
    const m = parseVrmMeta(vrm0({ allowedUserName: 'Everyone', commercialUssageName: 'Disallow', licenseName: 'Other', otherLicenseUrl: url }));
    expect(m.creditNotation).toBe('required');
    expect(m.allowRedistribution).toBe(false);
    expect(m.modification).toBe('prohibited');
    expect(m.commercialUsage).toBe('personalNonProfit');
    // A look-alike host is ignored.
    const fake = parseVrmMeta(vrm0({ otherLicenseUrl: 'https://hub.vroid.com.evil.test/license?credit=unnecessary' }));
    expect(fake.creditNotation).toBeNull();
  });

  it('rejects non-VRM glTF', () => {
    expect(() => parseVrmMeta({ asset: { version: '2.0' } })).toThrow(/NOT A VRM/);
    expect(vrmSpecOf({ extensions: { VRM: {} } })).toBe('0.x');
    expect(vrmSpecOf({ extensions: { VRMC_vrm: {} } })).toBe('1.0');
    expect(vrmSpecOf({})).toBeNull();
  });
});

describe('GLB reader', () => {
  it('reads the JSON chunk', () => {
    const m = readVrmMeta(glb(vrm1({ name: 'Glb' })));
    expect(m.name).toBe('Glb');
  });
  it('says "not a VRM" for other files', () => {
    expect(() => readGlbJson(new TextEncoder().encode('hello world, this is not a model').buffer)).toThrow(/NOT A VRM/);
    expect(() => readGlbJson(new ArrayBuffer(4))).toThrow(/NOT A VRM/);
    expect(() => readVrmMeta(glb({ asset: { version: '2.0' } }))).toThrow(/NOT A VRM/);
  });
});

describe('licence summary', () => {
  const sum = (meta: Record<string, unknown>, v: 0 | 1 = 1) => summarizeLicence(parseVrmMeta(v ? vrm1(meta) : vrm0(meta)));

  it('AUTHOR ONLY wins over everything and is restricted', () => {
    const s = sum({ ...FULL_1, avatarPermission: 'onlyAuthor' });
    expect(s.badge).toBe('AUTHOR ONLY');
    expect(s.tone).toBe('warn');
    expect(s.restricted).toBe(true);
    expect(sum({ allowedUserName: 'OnlyAuthor', licenseName: 'CC0' }, 0).badge).toBe('AUTHOR ONLY');
  });
  it('LICENSED ONLY', () => {
    const s = sum({ avatarPermission: 'onlySeparatelyLicensedPerson' });
    expect(s.badge).toBe('LICENSED ONLY');
    expect(s.restricted).toBe(true);
  });
  it('CC0 (0.x licence name and 1.0 licence URL)', () => {
    expect(sum({ allowedUserName: 'Everyone', commercialUssageName: 'Allow', licenseName: 'CC0' }, 0).badge).toBe('CC0');
    expect(sum({ avatarPermission: 'everyone', otherLicenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' }).badge).toBe('CC0');
  });
  it('commercial levels', () => {
    expect(sum({ avatarPermission: 'everyone', commercialUsage: 'corporation' }).badge).toBe('COMMERCIAL OK');
    expect(sum({ avatarPermission: 'everyone', commercialUsage: 'personalProfit' }).badge).toBe('SOLO COMMERCIAL');
    const p = sum({ avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' });
    expect(p.badge).toBe('PERSONAL');
    expect(p.restricted).toBe(false);
    expect(sum({ allowedUserName: 'Everyone', commercialUssageName: 'Allow', licenseName: 'CC_BY' }, 0).badge).toBe('SOLO COMMERCIAL');
  });
  it('no terms at all', () => {
    const s = sum({});
    expect(s.badge).toBe('NO TERMS');
    expect(s.tone).toBe('unknown');
    expect(s.lines.find((l) => l.label === 'WHO MAY PERFORM AS IT')?.value).toBe('NOT STATED');
  });
  it('plain-language lines', () => {
    const s = sum(FULL_1);
    const v = (label: string) => s.lines.find((l) => l.label === label);
    expect(v('WHO MAY PERFORM AS IT')).toMatchObject({ value: 'EVERYONE', mark: 'yes' });
    expect(v('VIOLENT CONTENT')).toMatchObject({ value: 'ALLOWED', mark: 'yes' });
    expect(v('SEXUAL CONTENT')).toMatchObject({ value: 'NOT ALLOWED', mark: 'no' });
    expect(v('CREDIT THE AUTHOR')?.value).toBe('REQUIRED');
    expect(v('MODIFY IT')?.value).toBe('ALLOWED (DO NOT SHARE EDITS)');
    expect(v('AUTHORS')?.value).toBe('Alice, Bob');
    expect(v('LICENCE URL')?.value).toBe('https://example.com/terms');
    // 0.x models do not get 1.0-only rows they cannot answer.
    expect(sum({ allowedUserName: 'Everyone' }, 0).lines.some((l) => l.label === 'POLITICAL / RELIGIOUS')).toBe(false);
  });
});

// ---------------------------------------------------------------- index

const id = (n: number) => n.toString(16).padStart(64, '0');

function info(n: number, name: string, author = 'Anon'): ModelInfo {
  return {
    infoVersion: 1,
    id: id(n),
    fileName: `${name}.vrm`,
    size: 1000,
    spec: '1.0',
    meta: parseVrmMeta(vrm1({ name, authors: [author] })),
    stats: { perfectSync: 0, presets: 13, expressions: 13, springChains: 0, springJoints: 0, polygons: 100 },
    importedAt: 0,
    sourcePath: null,
    thumbAt: null,
  };
}

describe('library index', () => {
  it('validates ids (sha256 hex only)', () => {
    expect(isValidId(id(1))).toBe(true);
    expect(isValidId('../' + id(1).slice(3))).toBe(false);
    expect(isValidId(id(1).toUpperCase().replace(/0/g, 'A'))).toBe(false);
    expect(isValidId('')).toBe(false);
  });

  it('dedups by hash: re-adding keeps the original entry', () => {
    const idx = emptyIndex();
    expect(addEntry(idx, id(1), 100).added).toBe(true);
    setFavourite(idx, id(1), true);
    const again = addEntry(idx, id(1), 200);
    expect(again.added).toBe(false);
    expect(again.entry.addedAt).toBe(100);
    expect(again.entry.favourite).toBe(true);
    expect(Object.keys(idx.entries)).toHaveLength(1);
    expect(() => addEntry(idx, 'nope', 1)).toThrow();
  });

  it('round-trips and parses leniently', () => {
    const idx = emptyIndex();
    addEntry(idx, id(1), 5);
    rename(idx, id(1), '  My Model  ');
    markUsed(idx, id(1), 9);
    idx.migration = 'done';
    const back = parseIndex(serializeIndex(idx));
    expect(back).toEqual(idx);
    expect(back.entries[id(1)].customName).toBe('My Model');
    expect(parseIndex('{broken').entries).toEqual({});
    expect(parseIndex(null).migration).toBe('pending');
    const junk = parseIndex(JSON.stringify({ entries: { '../../etc': { favourite: true }, [id(2)]: { favourite: 'yes', addedAt: 'x' } } }));
    expect(Object.keys(junk.entries)).toEqual([id(2)]);
    expect(junk.entries[id(2)]).toEqual({ favourite: false, addedAt: 0, lastUsedAt: null, customName: null, noticeSeen: false });
    rename(idx, id(1), '   ');
    expect(idx.entries[id(1)].customName).toBeNull();
  });

  it('reconciles with what is stored', () => {
    const idx = emptyIndex();
    addEntry(idx, id(1), 1);
    addEntry(idx, id(2), 1);
    expect(reconcile(idx, [id(2), id(3), 'garbage'], 50)).toBe(true);
    expect(Object.keys(idx.entries).sort()).toEqual([id(2), id(3)]);
    expect(idx.entries[id(3)].addedAt).toBe(50);
    expect(reconcile(idx, [id(2), id(3)], 60)).toBe(false);
  });

  const items = (): LibraryItem[] => {
    const idx = emptyIndex();
    const mk = (n: number, name: string, author: string, added: number, used: number | null, fav = false) => {
      addEntry(idx, id(n), added);
      if (used !== null) markUsed(idx, id(n), used);
      setFavourite(idx, id(n), fav);
      return { id: id(n), entry: idx.entries[id(n)], info: info(n, name, author) };
    };
    return [
      mk(1, 'Zed', 'Polygonal Mind', 10, 500),
      mk(2, 'Alpha', 'Supra', 20, null),
      mk(3, 'Morrígan', 'Spartan', 30, 100, true),
      mk(4, 'beta', 'Polygonal Mind', 40, 900),
      mk(5, 'Gamma', 'Anon', 50, null, true),
    ];
  };
  const names = (l: LibraryItem[]) => l.map((i) => displayName(i));

  it('ALL puts favourites first, then the chosen sort', () => {
    expect(names(queryLibrary(items(), { filter: 'all', search: '', sort: 'used' }))).toEqual(['Morrígan', 'Gamma', 'beta', 'Zed', 'Alpha']);
    expect(names(queryLibrary(items(), { filter: 'all', search: '', sort: 'name' }))).toEqual(['Gamma', 'Morrígan', 'Alpha', 'beta', 'Zed']);
    expect(names(queryLibrary(items(), { filter: 'all', search: '', sort: 'added' }))).toEqual(['Gamma', 'Morrígan', 'beta', 'Alpha', 'Zed']);
  });

  it('FAVOURITES shows only favourites', () => {
    expect(names(queryLibrary(items(), { filter: 'favourites', search: '', sort: 'name' }))).toEqual(['Gamma', 'Morrígan']);
  });

  it('search matches name and author, accent- and case-insensitive', () => {
    expect(names(queryLibrary(items(), { filter: 'all', search: 'polygonal', sort: 'name' }))).toEqual(['beta', 'Zed']);
    expect(names(queryLibrary(items(), { filter: 'all', search: 'MORRIGAN', sort: 'name' }))).toEqual(['Morrígan']);
    expect(names(queryLibrary(items(), { filter: 'all', search: 'mind zed', sort: 'name' }))).toEqual(['Zed']);
    expect(queryLibrary(items(), { filter: 'favourites', search: 'zed', sort: 'name' })).toEqual([]);
  });

  it('custom names win for display and search', () => {
    const l = items();
    l[1].entry.customName = 'Renamed';
    expect(displayName(l[1])).toBe('Renamed');
    expect(names(queryLibrary(l, { filter: 'all', search: 'renamed', sort: 'name' }))).toEqual(['Renamed']);
    // Fallback to the file name when the model has no name.
    expect(displayName({ entry: l[0].entry, info: { ...info(9, ''), fileName: 'shapey.vrm' } })).toBe('shapey');
  });
});

describe('index writer (atomic, ordered saves)', () => {
  it('writes whole documents in order and coalesces bursts to the newest', async () => {
    const written: string[] = [];
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const w = new IndexWriter(async (json) => {
      written.push(json);
      await gate;
    });
    const idx = emptyIndex();
    addEntry(idx, id(1), 1);
    const p1 = w.save(idx);
    setFavourite(idx, id(1), true);
    w.save(idx);
    rename(idx, id(1), 'Final');
    w.save(idx);
    expect(written).toHaveLength(1); // first write in flight, the rest wait
    release();
    gate = Promise.resolve();
    await p1;
    await w.flush();
    expect(written).toHaveLength(2); // the two queued saves collapsed into one
    const last = parseIndex(written[1]);
    expect(last.entries[id(1)]).toMatchObject({ favourite: true, customName: 'Final' });
    for (const doc of written) expect(() => JSON.parse(doc)).not.toThrow();
  });

  it('surfaces write errors and recovers', async () => {
    let fail = true;
    const w = new IndexWriter(async () => {
      if (fail) throw new Error('disk full');
    });
    await expect(w.save(emptyIndex())).rejects.toThrow('disk full');
    fail = false;
    await expect(w.save(emptyIndex())).resolves.toBeUndefined();
  });
});

describe('formatting', () => {
  const now = 1_000_000_000_000;
  it('relative times', () => {
    expect(formatAgo(null, now)).toBe('NEVER USED');
    expect(formatAgo(now - 5_000, now)).toBe('JUST NOW');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 MIN AGO');
    expect(formatAgo(now - 3 * 3600_000, now)).toBe('3 H AGO');
    expect(formatAgo(now - 30 * 3600_000, now)).toBe('YESTERDAY');
    expect(formatAgo(now - 10 * 86400_000, now)).toBe('10 DAYS AGO');
  });
  it('sizes and counts', () => {
    expect(formatBytes(1_828_632)).toBe('1.7 MB');
    expect(formatBytes(35_496_968)).toBe('34 MB');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatCount(950)).toBe('950');
    expect(formatCount(52_400)).toBe('52K');
    expect(formatCount(5_400)).toBe('5.4K');
    expect(formatCount(1_250_000)).toBe('1.3M');
  });
});

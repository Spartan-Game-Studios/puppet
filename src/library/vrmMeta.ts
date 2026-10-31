/**
 * VRM meta (licence and credits) for VRM 0.x and 1.0, normalised to one
 * shape, plus a plain-language licence summary.
 *
 * Pure: no DOM, no three.js. Works on the glTF JSON chunk only, so it can read
 * a model's terms before (or without) loading the model.
 *
 * Mapping 0.x -> 1.0 follows the VRM consortium's migration rules (the same
 * ones UniVRM applies): `allowedUserName` OnlyAuthor / ExplicitlyLicensedPerson
 * / Everyone -> `avatarPermission` onlyAuthor / onlySeparatelyLicensedPerson /
 * everyone; `commercialUssageName` Allow / Disallow -> `commercialUsage`
 * personalProfit / personalNonProfit; `violentUssageName` and
 * `sexualUssageName` -> the two `allowExcessively*` flags. VRM 0.x has no
 * political / antisocial / credit / redistribution / modification fields of
 * its own: those come from the licence name (CC0, CC_BY, ...) or a VRoid Hub
 * licence URL when one is present, and are otherwise unknown (null).
 */

import { t, type Key } from '../i18n';

export type VrmSpec = '0.x' | '1.0';
export type AvatarPermission = 'onlyAuthor' | 'onlySeparatelyLicensedPerson' | 'everyone';
export type CommercialUsage = 'personalNonProfit' | 'personalProfit' | 'corporation';
export type CreditNotation = 'required' | 'unnecessary';
export type Modification = 'prohibited' | 'allowModification' | 'allowModificationRedistribution';

export interface VrmMeta {
  spec: VrmSpec;
  name: string;
  version: string;
  authors: string[];
  copyright: string;
  contact: string;
  references: string[];
  thirdPartyLicenses: string;
  /** VRM 1.0 `licenseUrl` (usually https://vrm.dev/licenses/1.0/). */
  licenseUrl: string;
  /** VRM 0.x `licenseName` (CC0, CC_BY, Redistribution_Prohibited, Other, ...). */
  licenseName: string;
  otherLicenseUrl: string;
  /** VRM 0.x `otherPermissionUrl`. */
  otherPermissionUrl: string;
  /** null = the model does not say. */
  avatarPermission: AvatarPermission | null;
  commercialUsage: CommercialUsage | null;
  allowViolent: boolean | null;
  allowSexual: boolean | null;
  allowPolitical: boolean | null;
  allowAntisocial: boolean | null;
  creditNotation: CreditNotation | null;
  allowRedistribution: boolean | null;
  modification: Modification | null;
}

/** Literal "undefined" / "null" strings (one exporter writes them) count as empty. */
export function clean(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim();
  return s === 'undefined' || s === 'null' ? '' : s;
}

const cleanList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(clean).filter(Boolean);

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  const s = clean(v);
  return (allowed as readonly string[]).includes(s) ? (s as T) : null;
}

const allowDisallow = (v: unknown): boolean | null => {
  const s = clean(v).toLowerCase();
  return s === 'allow' ? true : s === 'disallow' ? false : null;
};

/** Read the JSON chunk of a GLB (.vrm) file. Throws "NOT A VRM ..." on anything else. */
export function readGlbJson(buf: ArrayBuffer): Record<string, unknown> {
  if (buf.byteLength < 20) throw new Error('NOT A VRM (FILE TOO SMALL)');
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('NOT A VRM (NOT A GLB FILE)');
  const len = dv.getUint32(12, true);
  const type = dv.getUint32(16, true);
  if (type !== 0x4e4f534a || 20 + len > buf.byteLength) throw new Error('NOT A VRM (BAD GLB JSON CHUNK)');
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
  } catch {
    throw new Error('NOT A VRM (UNREADABLE GLB JSON)');
  }
  if (!json || typeof json !== 'object') throw new Error('NOT A VRM (BAD GLB JSON)');
  return json as Record<string, unknown>;
}

/** Which VRM extension the glTF carries, if any. */
export function vrmSpecOf(gltf: Record<string, unknown>): VrmSpec | null {
  const ext = (gltf.extensions ?? {}) as Record<string, unknown>;
  if (ext.VRMC_vrm) return '1.0';
  if (ext.VRM) return '0.x';
  return null;
}

/** VRoid Hub licence URLs carry the terms as query parameters. */
function vroidHubTerms(url: string): Partial<VrmMeta> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {};
  }
  if (!/(^|\.)hub\.vroid\.com$/.test(u.hostname)) return {};
  const q = u.searchParams;
  const ad = (k: string) => (q.get(k) === 'allow' ? true : q.get(k) === 'disallow' ? false : null);
  const out: Partial<VrmMeta> = {};
  const credit = q.get('credit');
  if (credit === 'necessary') out.creditNotation = 'required';
  else if (credit === 'unnecessary') out.creditNotation = 'unnecessary';
  const redis = ad('redistribution');
  if (redis !== null) out.allowRedistribution = redis;
  const mod = ad('modification');
  if (mod !== null) out.modification = mod ? (redis ? 'allowModificationRedistribution' : 'allowModification') : 'prohibited';
  const corp = ad('corporate_commercial_use');
  const pers = ad('personal_commercial_use');
  if (corp) out.commercialUsage = 'corporation';
  else if (pers) out.commercialUsage = 'personalProfit';
  else if (corp === false && pers === false) out.commercialUsage = 'personalNonProfit';
  return out;
}

/** Terms implied by a VRM 0.x `licenseName`. */
function licenceNameTerms(name: string): Partial<VrmMeta> {
  switch (name) {
    case 'Redistribution_Prohibited':
      return { allowRedistribution: false };
    case 'CC0':
      return { creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' };
    case 'CC_BY':
    case 'CC_BY_NC':
    case 'CC_BY_SA':
    case 'CC_BY_NC_SA':
      return { creditNotation: 'required', allowRedistribution: true, modification: 'allowModificationRedistribution' };
    case 'CC_BY_ND':
    case 'CC_BY_NC_ND':
      return { creditNotation: 'required', allowRedistribution: true, modification: 'prohibited' };
    default:
      return {};
  }
}

function empty(spec: VrmSpec): VrmMeta {
  return {
    spec,
    name: '',
    version: '',
    authors: [],
    copyright: '',
    contact: '',
    references: [],
    thirdPartyLicenses: '',
    licenseUrl: '',
    licenseName: '',
    otherLicenseUrl: '',
    otherPermissionUrl: '',
    avatarPermission: null,
    commercialUsage: null,
    allowViolent: null,
    allowSexual: null,
    allowPolitical: null,
    allowAntisocial: null,
    creditNotation: null,
    allowRedistribution: null,
    modification: null,
  };
}

/** Normalised meta from a glTF JSON document. Throws "NOT A VRM" if it has no VRM extension. */
export function parseVrmMeta(gltf: Record<string, unknown>): VrmMeta {
  const ext = (gltf.extensions ?? {}) as Record<string, any>;
  if (ext.VRMC_vrm) {
    const m = (ext.VRMC_vrm.meta ?? {}) as Record<string, unknown>;
    const out = empty('1.0');
    out.name = clean(m.name);
    out.version = clean(m.version);
    out.authors = cleanList(m.authors);
    out.copyright = clean(m.copyrightInformation);
    out.contact = clean(m.contactInformation);
    out.references = cleanList(m.references);
    out.thirdPartyLicenses = clean(m.thirdPartyLicenses);
    out.licenseUrl = clean(m.licenseUrl);
    out.otherLicenseUrl = clean(m.otherLicenseUrl);
    out.avatarPermission = oneOf(m.avatarPermission, ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone'] as const);
    out.commercialUsage = oneOf(m.commercialUsage, ['personalNonProfit', 'personalProfit', 'corporation'] as const);
    out.allowViolent = bool(m.allowExcessivelyViolentUsage);
    out.allowSexual = bool(m.allowExcessivelySexualUsage);
    out.allowPolitical = bool(m.allowPoliticalOrReligiousUsage);
    out.allowAntisocial = bool(m.allowAntisocialOrHateUsage);
    out.creditNotation = oneOf(m.creditNotation, ['required', 'unnecessary'] as const);
    out.allowRedistribution = bool(m.allowRedistribution);
    out.modification = oneOf(m.modification, ['prohibited', 'allowModification', 'allowModificationRedistribution'] as const);
    return out;
  }
  if (ext.VRM) {
    const m = (ext.VRM.meta ?? {}) as Record<string, unknown>;
    const out = empty('0.x');
    out.name = clean(m.title);
    out.version = clean(m.version);
    out.authors = cleanList(m.author);
    out.contact = clean(m.contactInformation);
    out.references = cleanList(m.reference);
    out.licenseName = clean(m.licenseName);
    out.otherLicenseUrl = clean(m.otherLicenseUrl);
    out.otherPermissionUrl = clean(m.otherPermissionUrl);
    const user = clean(m.allowedUserName);
    out.avatarPermission =
      user === 'OnlyAuthor' ? 'onlyAuthor' : user === 'ExplicitlyLicensedPerson' ? 'onlySeparatelyLicensedPerson' : user === 'Everyone' ? 'everyone' : null;
    out.allowViolent = allowDisallow(m.violentUssageName);
    out.allowSexual = allowDisallow(m.sexualUssageName);
    const com = allowDisallow(m.commercialUssageName);
    out.commercialUsage = com === null ? null : com ? 'personalProfit' : 'personalNonProfit';
    // Licence name first, then a VRoid Hub URL (more specific) on top.
    Object.assign(out, licenceNameTerms(out.licenseName));
    for (const url of [out.otherLicenseUrl, out.otherPermissionUrl]) {
      const t = vroidHubTerms(url);
      for (const [k, v] of Object.entries(t)) if (v !== null && v !== undefined) (out as any)[k] = v;
    }
    return out;
  }
  throw new Error('NOT A VRM (NO VRM EXTENSION)');
}

/** Convenience: meta straight from file bytes. */
export function readVrmMeta(buf: ArrayBuffer): VrmMeta {
  return parseVrmMeta(readGlbJson(buf));
}

// ---------------------------------------------------------------- licence summary

export type LicenceTone = 'warn' | 'ok' | 'info' | 'unknown';
export type LicenceBadge = 'AUTHOR ONLY' | 'LICENSED ONLY' | 'CC0' | 'COMMERCIAL OK' | 'SOLO COMMERCIAL' | 'PERSONAL' | 'NO TERMS';

/**
 * One letter per badge, for the square licence badge in the stage's bottom bar.
 * No two share a letter; the tooltip spells the badge out (LICENCE_LETTER_TITLE).
 */
export const LICENCE_LETTER: Readonly<Record<LicenceBadge, string>> = {
  'AUTHOR ONLY': 'A',
  'LICENSED ONLY': 'L',
  CC0: 'C',
  'COMMERCIAL OK': 'B', // business: companies too
  'SOLO COMMERCIAL': 'S',
  PERSONAL: 'P',
  'NO TERMS': 'N',
};

const BADGE_KEY: Readonly<Record<LicenceBadge, string>> = {
  'AUTHOR ONLY': 'authorOnly',
  'LICENSED ONLY': 'licensedOnly',
  CC0: 'cc0',
  'COMMERCIAL OK': 'commercialOk',
  'SOLO COMMERCIAL': 'soloCommercial',
  PERSONAL: 'personal',
  'NO TERMS': 'noTerms',
};

/** The badge as shown, in the UI language (the LicenceBadge id itself stays English). */
export const badgeLabel = (badge: LicenceBadge): string => t(`library.badge.${BADGE_KEY[badge]}` as Key);

/** Tooltip for the letter badge: "A · AUTHOR ONLY". */
export function licenceLetterTitle(badge: LicenceBadge): string {
  return t(badge === 'COMMERCIAL OK' ? 'library.letterTitleBusiness' : 'library.letterTitle', { letter: LICENCE_LETTER[badge], badge: badgeLabel(badge) });
}

export interface LicenceLine {
  label: string;
  value: string;
  /** 'no' marks a restriction, 'yes' a permission, '' a plain fact. */
  mark: 'yes' | 'no' | '?' | '';
}

/** `badge` is an id (English, compared in code); `headline` and `lines` are in the UI language. */
export interface LicenceSummary {
  badge: LicenceBadge;
  tone: LicenceTone;
  /** One sentence for the badge tooltip and the notice. */
  headline: string;
  lines: LicenceLine[];
  /** True when loading should show the one-time "these are the model's terms" notice. */
  restricted: boolean;
}

const isCc0 = (m: VrmMeta) =>
  m.licenseName === 'CC0' || /creativecommons\.org\/publicdomain\/zero/i.test(`${m.licenseUrl} ${m.otherLicenseUrl}`);

const yn = (v: boolean | null, yes: string, no: string): [string, LicenceLine['mark']] =>
  v === null ? [t('library.val.notStated'), '?'] : v ? [yes, 'yes'] : [no, 'no'];

export function summarizeLicence(m: VrmMeta): LicenceSummary {
  const cc0 = isCc0(m);
  let badge: LicenceBadge;
  let tone: LicenceTone;
  let headline: string;
  if (m.avatarPermission === 'onlyAuthor') {
    badge = 'AUTHOR ONLY';
    tone = 'warn';
    headline = t('library.head.authorOnly');
  } else if (m.avatarPermission === 'onlySeparatelyLicensedPerson') {
    badge = 'LICENSED ONLY';
    tone = 'warn';
    headline = t('library.head.licensedOnly');
  } else if (cc0) {
    badge = 'CC0';
    tone = 'ok';
    headline = t('library.head.cc0');
  } else if (m.commercialUsage === 'corporation') {
    badge = 'COMMERCIAL OK';
    tone = 'ok';
    headline = t('library.head.commercialOk');
  } else if (m.commercialUsage === 'personalProfit') {
    badge = 'SOLO COMMERCIAL';
    tone = 'ok';
    headline = t('library.head.soloCommercial');
  } else if (m.commercialUsage === 'personalNonProfit') {
    badge = 'PERSONAL';
    tone = 'info';
    headline = t('library.head.personal');
  } else {
    badge = 'NO TERMS';
    tone = 'unknown';
    headline = t('library.head.noTerms');
  }

  const lines: LicenceLine[] = [];
  const ALLOWED = t('library.val.allowed');
  const NOT_ALLOWED = t('library.val.notAllowed');
  const who =
    m.avatarPermission === 'onlyAuthor'
      ? ([t('library.val.authorOnly'), 'no'] as const)
      : m.avatarPermission === 'onlySeparatelyLicensedPerson'
        ? ([t('library.val.licensedPeople'), 'no'] as const)
        : m.avatarPermission === 'everyone'
          ? ([t('library.val.everyone'), 'yes'] as const)
          : ([t('library.val.notStated'), '?'] as const);
  lines.push({ label: t('library.lic.who'), value: who[0], mark: who[1] });
  const com =
    m.commercialUsage === 'corporation'
      ? ([t('library.val.companies'), 'yes'] as const)
      : m.commercialUsage === 'personalProfit'
        ? ([t('library.val.individuals'), 'yes'] as const)
        : m.commercialUsage === 'personalNonProfit'
          ? ([t('library.val.nonProfit'), 'no'] as const)
          : ([t('library.val.notStated'), '?'] as const);
  lines.push({ label: t('library.lic.commercial'), value: com[0], mark: com[1] });
  const push = (label: string, v: boolean | null, yes: string, no: string) => {
    const [value, mark] = yn(v, yes, no);
    lines.push({ label, value, mark });
  };
  push(t('library.lic.violent'), m.allowViolent, ALLOWED, NOT_ALLOWED);
  push(t('library.lic.sexual'), m.allowSexual, ALLOWED, NOT_ALLOWED);
  if (m.spec === '1.0' || m.allowPolitical !== null) push(t('library.lic.political'), m.allowPolitical, ALLOWED, NOT_ALLOWED);
  if (m.spec === '1.0' || m.allowAntisocial !== null) push(t('library.lic.antisocial'), m.allowAntisocial, ALLOWED, NOT_ALLOWED);
  lines.push({
    label: t('library.lic.credit'),
    value: m.creditNotation === 'required' ? t('library.val.required') : m.creditNotation === 'unnecessary' ? t('library.val.notNeeded') : t('library.val.notStated'),
    mark: m.creditNotation === 'required' ? 'no' : m.creditNotation === 'unnecessary' ? 'yes' : '?',
  });
  push(t('library.lic.redistribute'), m.allowRedistribution, ALLOWED, NOT_ALLOWED);
  lines.push({
    label: t('library.lic.modify'),
    value:
      m.modification === 'prohibited'
        ? NOT_ALLOWED
        : m.modification === 'allowModification'
          ? t('library.val.modNoShare')
          : m.modification === 'allowModificationRedistribution'
            ? t('library.val.modShare')
            : t('library.val.notStated'),
    mark: m.modification === 'prohibited' ? 'no' : m.modification ? 'yes' : '?',
  });
  if (m.licenseName) lines.push({ label: t('library.lic.licence'), value: m.licenseName.replace(/_/g, ' ').toUpperCase(), mark: '' });
  const url = m.otherLicenseUrl || m.licenseUrl || m.otherPermissionUrl;
  if (url) lines.push({ label: t('library.lic.url'), value: url, mark: '' });
  if (m.otherPermissionUrl && m.otherPermissionUrl !== url) lines.push({ label: t('library.lic.permUrl'), value: m.otherPermissionUrl, mark: '' });
  if (m.authors.length) lines.push({ label: m.authors.length > 1 ? t('library.lic.authors') : t('library.lic.author'), value: m.authors.join(', '), mark: '' });
  if (m.copyright) lines.push({ label: t('library.lic.copyright'), value: m.copyright, mark: '' });
  if (m.contact) lines.push({ label: t('library.lic.contact'), value: m.contact, mark: '' });
  if (m.references.length) lines.push({ label: t('library.lic.basedOn'), value: m.references.join(', '), mark: '' });
  if (m.thirdPartyLicenses) lines.push({ label: t('library.lic.thirdParty'), value: m.thirdPartyLicenses, mark: '' });

  return { badge, tone, headline, lines, restricted: tone === 'warn' };
}

/**
 * The clip catalogue: built-in clips (CC0 Quaternius Universal Animation
 * Library, bundled as public/clips/ual.glb, plus VPuppet's own keyframed
 * emotes) and the user's imported FBX / glTF clips.
 */
import { t } from '../i18n';
import type { BoneMask } from './masks';
import type { RootMotion } from './retarget';

export type ClipKind = 'idle' | 'emote';

export type ClipSource =
  | { type: 'ual'; anim: string }
  | { type: 'authored'; name: string }
  | { type: 'user'; file: string; ext: 'fbx' | 'glb'; anim: string };

export interface ClipDef {
  id: string;
  label: string;
  kind: ClipKind;
  mask: BoneMask;
  /** Loops until stopped (idles, dance, sit); otherwise plays once and blends back. */
  loop: boolean;
  rootMotion: RootMotion;
  source: ClipSource;
}

/** Per-clip overrides the user sets in 07 MOTION (persisted in settings). */
export interface ClipOptions {
  mask?: BoneMask;
  loop?: boolean;
  rootMotion?: RootMotion;
  label?: string;
}

const ual = (id: string, label: string, kind: ClipKind, mask: BoneMask, loop: boolean, anim = id): ClipDef => ({
  id: `builtin:${id}`,
  label,
  kind,
  mask,
  loop,
  rootMotion: 'inplace',
  source: { type: 'ual', anim },
});
const own = (id: string, label: string, mask: BoneMask): ClipDef => ({
  id: `builtin:${id}`,
  label,
  kind: 'emote',
  mask,
  loop: false,
  rootMotion: 'off',
  source: { type: 'authored', name: id },
});

/** Labels are translated (motion.clip.<id>); ids and the persisted settings use only `id`. */
export const BUILTIN_CLIPS: ClipDef[] = [
  ual('idle', t('motion.clip.idle'), 'idle', 'full', true),
  ual('idle_look', t('motion.clip.idle_look'), 'idle', 'full', true),
  ual('idle_talk', t('motion.clip.idle_talk'), 'idle', 'full', true),
  ual('idle_arms_folded', t('motion.clip.idle_arms_folded'), 'idle', 'full', true),
  own('wave', t('motion.clip.wave'), 'arms'),
  ual('yes', t('motion.clip.yes'), 'emote', 'head', false),
  ual('no', t('motion.clip.no'), 'emote', 'head', false),
  own('clap', t('motion.clip.clap'), 'arms'),
  ual('cheer', t('motion.clip.cheer'), 'emote', 'body', false),
  ual('dance', t('motion.clip.dance'), 'emote', 'full', true),
  own('bow', t('motion.clip.bow'), 'full'),
  own('point', t('motion.clip.point'), 'arms'),
  own('shrug', t('motion.clip.shrug'), 'body'),
  own('think', t('motion.clip.think'), 'body'),
  ual('angry', t('motion.clip.angry'), 'emote', 'body', false),
  ual('cry', t('motion.clip.cry'), 'emote', 'body', false),
  ual('drink', t('motion.clip.drink'), 'emote', 'arms', false),
  ual('sit', t('motion.clip.sit'), 'emote', 'full', true),
];

export const DEFAULT_IDLE = 'builtin:idle';

/** A user clip as stored in settings (the file lives in <appData>/clips/<file>/). */
export interface UserClipEntry {
  /** `user:<sha256>:<animation index>` */
  id: string;
  /** SHA-256 of the file. */
  file: string;
  ext: 'fbx' | 'glb';
  /** Index of the animation inside the file (as a string). */
  anim: string;
  label: string;
  kind: ClipKind;
  rig: string;
  duration: number;
}

export function userClipDef(e: UserClipEntry): ClipDef {
  return {
    id: e.id,
    label: e.label,
    kind: e.kind,
    mask: e.kind === 'idle' ? 'full' : 'body',
    loop: e.kind === 'idle',
    rootMotion: 'inplace',
    source: { type: 'user', file: e.file, ext: e.ext, anim: e.anim },
  };
}

export function withOptions(d: ClipDef, o: ClipOptions | undefined): ClipDef {
  if (!o) return d;
  return { ...d, mask: o.mask ?? d.mask, loop: o.loop ?? d.loop, rootMotion: o.rootMotion ?? d.rootMotion, label: o.label ?? d.label };
}

/** Guess idle vs emote from a clip's name. */
export const guessKind = (name: string): ClipKind => (/idle|breath|stand/i.test(name) ? 'idle' : 'emote');

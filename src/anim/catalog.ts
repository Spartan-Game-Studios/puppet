/**
 * The clip catalogue: built-in clips (CC0 Quaternius Universal Animation
 * Library, bundled as public/clips/ual.glb, plus Puppet's own keyframed
 * emotes) and the user's imported FBX / glTF clips.
 */
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

export const BUILTIN_CLIPS: ClipDef[] = [
  ual('idle', 'IDLE: BREATHE', 'idle', 'full', true),
  ual('idle_look', 'IDLE: LOOK AROUND', 'idle', 'full', true),
  ual('idle_talk', 'IDLE: TALKING', 'idle', 'full', true),
  ual('idle_arms_folded', 'IDLE: ARMS FOLDED', 'idle', 'full', true),
  own('wave', 'WAVE', 'arms'),
  ual('yes', 'NOD (YES)', 'emote', 'head', false),
  ual('no', 'SHAKE (NO)', 'emote', 'head', false),
  own('clap', 'CLAP', 'arms'),
  ual('cheer', 'CHEER', 'emote', 'body', false),
  ual('dance', 'DANCE', 'emote', 'full', true),
  own('bow', 'BOW', 'full'),
  own('point', 'POINT', 'arms'),
  own('shrug', 'SHRUG', 'body'),
  own('think', 'THINK', 'body'),
  ual('angry', 'ANGRY', 'emote', 'body', false),
  ual('cry', 'CRY', 'emote', 'body', false),
  ual('drink', 'DRINK', 'emote', 'arms', false),
  ual('sit', 'SIT', 'emote', 'full', true),
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

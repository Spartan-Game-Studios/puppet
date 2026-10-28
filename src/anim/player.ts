/**
 * The animation layer over tracking (an AvatarLayer, see scene/avatar.ts).
 *
 *  - Idle: while body tracking is off (FACE mode) or lost, an idle loop drives
 *    the body instead of a static pose. With the face tracked the head stays
 *    the face's; with the face lost too the idle owns the head.
 *  - Emotes: one-shot (or looping) clips over live tracking, each owning the
 *    bones of its mask, with crossfades in and out. Face tracking keeps the
 *    face; expressions and lip sync go through the expression hook.
 *
 * Every change of weight is a ramp, and clips are applied as a slerp from the
 * tracked pose, so a clip start is a continuous motion for the spring / cloth
 * solvers rather than a jump.
 */
import { Quaternion, Vector3 } from 'three';
import type { Avatar, AvatarLayer } from '../scene/avatar';
import { ExpressionOverlay } from './expressions';
import type { ClipLibrary } from './library';
import { isHeadBone, maskHas, maskMovesHips, type BoneMask } from './masks';
import { sampleBone, sampleHips, toVrmBone, toVrmDir, type BoundClip } from './retarget';
import type { LipSync } from '../audio/lipsync';
import { DEFAULT_IDLE } from './catalog';

interface Track {
  id: string;
  clip: BoundClip;
  mask: BoneMask;
  loop: boolean;
  t: number;
  w: number;
  target: number;
  fadeIn: number;
  fadeOut: number;
}

export interface AnimSettings {
  /** Idle clip id, or null for the static idle pose. */
  idle: string | null;
  /** Play the idle in FACE mode too (body tracking off), not only when tracking is lost. */
  idleInFaceMode: boolean;
  /** Crossfade seconds. */
  fadeIn: number;
  fadeOut: number;
}
export const DEFAULT_ANIM: AnimSettings = { idle: DEFAULT_IDLE, idleInFaceMode: true, fadeIn: 0.3, fadeOut: 0.45 };

const _q = new Quaternion();

/** Largest hips offset in a clip (metres). */
function hipsTravel(clip: BoundClip): number {
  const h = clip.hips;
  if (!h) return 0;
  let m = 0;
  for (let i = 0; i < h.length; i += 3) m = Math.max(m, Math.hypot(h[i], h[i + 1], h[i + 2]));
  return m;
}
const _v = new Vector3();

export class AnimLayer implements AvatarLayer {
  readonly overlay = new ExpressionOverlay();
  settings: AnimSettings;
  lipsync: LipSync | null = null;
  private idle: Track | null = null;
  private idleHeadW = 0;
  private emotes: Track[] = [];
  private hipsRest: Vector3 | null = null;
  private hipsMoved = false;
  private loadingIdle: string | null = null;
  /** Errors surface here (status bar). */
  onError: (msg: string) => void = () => {};
  /** Fires when the set of playing emotes changes (UI highlight). */
  onPlaying: (ids: string[]) => void = () => {};

  constructor(
    readonly avatar: Avatar,
    readonly library: ClipLibrary,
    settings: AnimSettings = DEFAULT_ANIM,
  ) {
    this.settings = { ...settings };
    const hips = avatar.bone('hips');
    if (hips) this.hipsRest = hips.position.clone();
    this.syncIdle();
  }

  /** The emotes currently playing (fading out ones excluded). */
  get playing(): string[] {
    return this.emotes.filter((e) => e.target > 0).map((e) => e.id);
  }
  get idleId(): string | null {
    return this.idle?.id ?? null;
  }

  setIdle(id: string | null): void {
    this.settings.idle = id;
    this.syncIdle();
  }

  private syncIdle(): void {
    const id = this.settings.idle;
    if (!id) {
      this.idle = null;
      return;
    }
    if (this.idle?.id === id || this.loadingIdle === id) return;
    this.loadingIdle = id;
    this.library
      .bind(this.avatar, id)
      .then(({ def, clip }) => {
        if (this.settings.idle !== id) return;
        // Crossfade from the old idle: start at its weight.
        const w = this.idle?.w ?? 0;
        this.idle = { id, clip, mask: def.mask, loop: true, t: 0, w, target: 0, fadeIn: 0.6, fadeOut: 0.6 };
      })
      .catch((e) => this.onError(`IDLE CLIP: ${(e as Error).message}`))
      .finally(() => {
        if (this.loadingIdle === id) this.loadingIdle = null;
      });
  }

  /** Play an emote over tracking. Triggering a looping emote that is playing stops it. */
  async play(id: string): Promise<void> {
    const running = this.emotes.find((e) => e.id === id && e.target > 0);
    if (running && running.loop) {
      running.target = 0;
      this.onPlaying(this.playing);
      return;
    }
    try {
      const { def, clip } = await this.library.bind(this.avatar, id);
      // Clips that move the hips (sit, crouch) cross-fade slower: a fast drop
      // pushes the legs through skirts faster than cloth collision can follow.
      const slow = maskMovesHips(def.mask) && hipsTravel(clip) > 0.05;
      // Other emotes fade out as this one fades in.
      for (const e of this.emotes) e.target = 0;
      // Restarting the same one-shot: let the old copy fade while the new one fades in.
      this.emotes.push({
        id,
        clip,
        mask: def.mask,
        loop: def.loop,
        t: 0,
        w: 0,
        target: 1,
        fadeIn: slow ? Math.max(0.8, this.settings.fadeIn) : this.settings.fadeIn,
        fadeOut: slow ? Math.max(0.8, this.settings.fadeOut) : Math.min(this.settings.fadeOut, clip.duration / 3),
      });
      this.onPlaying(this.playing);
    } catch (e) {
      this.onError(`CLIP: ${(e as Error).message}`);
    }
  }

  stopEmotes(): void {
    for (const e of this.emotes) e.target = 0;
    this.onPlaying(this.playing);
  }

  /** Reset: emotes and hotkey expressions off. */
  reset(): void {
    this.stopEmotes();
    this.overlay.reset();
  }

  private step(t: Track, dt: number): void {
    t.t += dt;
    if (!t.loop && t.target > 0 && t.t >= t.clip.duration - t.fadeOut) t.target = 0;
    const rate = t.target > t.w ? 1 / Math.max(1e-3, t.fadeIn) : 1 / Math.max(1e-3, t.fadeOut);
    t.w = t.target > t.w ? Math.min(t.target, t.w + rate * dt) : Math.max(t.target, t.w - rate * dt);
  }

  // ---------------------------------------------------------------- AvatarLayer

  body(avatar: Avatar, dt: number): void {
    const s = this.settings;
    // Idle wanted while the body isn't tracked (FACE mode counts unless switched off).
    const faceMode = avatar.drive.mode === 'face';
    const wantIdle = !!this.idle && !avatar.bodyTracked && (s.idleInFaceMode || !faceMode);
    if (this.idle) {
      this.idle.target = wantIdle ? 1 : 0;
      this.step(this.idle, dt);
    }
    const headWant = avatar.faceTracked ? 0 : 1;
    this.idleHeadW += (headWant - this.idleHeadW) * (1 - Math.exp(-dt / 0.3));

    const before = this.emotes.length;
    for (const e of this.emotes) this.step(e, dt);
    this.emotes = this.emotes.filter((e) => e.w > 0 || e.target > 0);
    if (this.emotes.length !== before) this.onPlaying(this.playing);

    const vrm0 = avatar.isVrm0;
    const hipsOff = _v.set(0, 0, 0);
    let hipsW = 0;
    const tmp = new Vector3();
    for (const track of this.layers()) {
      if (track.w <= 0) continue;
      for (const [bone] of track.clip.bones) {
        if (isHeadBone(bone) || !maskHas(track.mask, bone)) continue;
        const node = avatar.bone(bone);
        if (!node || !sampleBone(track.clip, bone, track.t, track.loop, _q)) continue;
        node.quaternion.slerp(toVrmBone(_q, vrm0), track.w);
      }
      if (maskMovesHips(track.mask) && sampleHips(track.clip, track.t, track.loop, tmp)) {
        // Layered lerp of the hips offset (later layers on top).
        hipsOff.lerp(tmp, track.w);
        hipsW = Math.max(hipsW, track.w);
      }
    }
    const hips = avatar.bone('hips');
    if (hips && this.hipsRest) {
      if (hipsW > 0) {
        hips.position.copy(this.hipsRest).add(toVrmDir(hipsOff, vrm0));
        this.hipsMoved = true;
      } else if (this.hipsMoved) {
        hips.position.copy(this.hipsRest);
        this.hipsMoved = false;
      }
    }
  }

  head(avatar: Avatar): void {
    const vrm0 = avatar.isVrm0;
    for (const track of this.layers()) {
      let w = track.w;
      if (track === this.idle) w *= this.idleHeadW;
      if (w <= 0) continue;
      for (const bone of ['neck', 'head']) {
        if (!maskHas(track.mask, bone)) continue;
        const node = avatar.bone(bone);
        if (!node || !sampleBone(track.clip, bone, track.t, track.loop, _q)) continue;
        node.quaternion.slerp(toVrmBone(_q, vrm0), w);
      }
    }
  }

  expressions(values: Map<string, number>, avatar: Avatar, dt: number): void {
    this.overlay.update(dt);
    if (this.lipsync) {
      this.lipsync.update(dt, avatar.faceTracked);
      this.lipsync.apply(values, avatar);
    }
    const names = new Set(avatar.expressionNames);
    this.overlay.apply(values, (n) => names.has(n));
  }

  private *layers(): Generator<Track> {
    if (this.idle) yield this.idle;
    yield* this.emotes;
  }
}

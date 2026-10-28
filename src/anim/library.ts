/**
 * Loads, retargets and caches clips: the bundled CC0 set, Puppet's authored
 * emotes and the user's imported FBX / glTF files.
 */
import type { AnimationClip, Object3D } from 'three';
import type { Avatar } from '../scene/avatar';
import { sha256Hex } from '../scene/avatar';
import { AUTHORED, bakeAuthored } from './authored';
import { BUILTIN_CLIPS, guessKind, userClipDef, withOptions, type ClipDef, type ClipOptions, type UserClipEntry } from './catalog';
import { clipBackend, type ClipBackend, type ClipExt } from './clipStore';
import { bindClip, extractSourceClip, type BoundClip, type SourceClip } from './retarget';
import { targetRig } from './target';
import type { TargetRig } from './retarget';

export interface LoadedFile {
  root: Object3D;
  clips: AnimationClip[];
}

/** Parse an animation file (FBX or binary glTF). */
export async function parseClipFile(buf: ArrayBuffer, ext: ClipExt | 'gltf'): Promise<LoadedFile> {
  if (ext === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const group = new FBXLoader().parse(buf, '');
    return { root: group, clips: group.animations ?? [] };
  }
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  return { root: gltf.scene, clips: gltf.animations ?? [] };
}

/** Sample every clip in a file (skips ones whose rig isn't recognised). */
export function extractAll(file: LoadedFile): { clips: Array<SourceClip & { index: number }>; errors: string[] } {
  const clips: Array<SourceClip & { index: number }> = [];
  const errors: string[] = [];
  for (const [index, c] of file.clips.entries()) {
    // FBX exports often carry an empty bind-pose take next to the real one.
    if (!(c.duration > 0.1) || !c.tracks.length) continue;
    try {
      clips.push({ ...extractSourceClip(file.root, c), index });
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { clips, errors };
}

export const extOf = (name: string): ClipExt | null => {
  const m = /\.(fbx|glb)$/i.exec(name);
  return m ? (m[1].toLowerCase() as ClipExt) : null;
};

export class ClipLibrary {
  readonly backend: ClipBackend;
  user: UserClipEntry[] = [];
  options: Record<string, ClipOptions> = {};
  private sources = new Map<string, Promise<SourceClip>>();
  private ualFile: Promise<Map<string, SourceClip>> | null = null;
  private userFiles = new Map<string, Promise<Map<string, SourceClip>>>();
  private bound = new WeakMap<Avatar, Map<string, BoundClip>>();
  private targets = new WeakMap<Avatar, TargetRig>();
  onChange: () => void = () => {};

  constructor(backend: ClipBackend = clipBackend(), private ualUrl = `${import.meta.env?.BASE_URL ?? '/'}clips/ual.glb`) {
    this.backend = backend;
  }

  async init(): Promise<void> {
    try {
      this.user = await this.backend.loadIndex();
    } catch (e) {
      console.warn('[clips] index unreadable', e);
      this.user = [];
    }
    this.onChange();
  }

  /** Every clip with the user's options applied. */
  all(): ClipDef[] {
    return [...BUILTIN_CLIPS, ...this.user.map(userClipDef)].map((d) => withOptions(d, this.options[d.id]));
  }
  get(id: string): ClipDef | undefined {
    return this.all().find((d) => d.id === id);
  }
  label(id: string): string {
    return this.get(id)?.label ?? id.replace(/^builtin:/, '').toUpperCase();
  }

  setOptions(id: string, o: ClipOptions): void {
    this.options[id] = { ...this.options[id], ...o };
    // Root motion is baked at bind time.
    if (o.rootMotion) this.bound = new WeakMap();
    this.onChange();
  }

  private loadUal(): Promise<Map<string, SourceClip>> {
    this.ualFile ??= (async () => {
      const r = await fetch(this.ualUrl);
      if (!r.ok) throw new Error(`built-in clips: HTTP ${r.status}`);
      const file = await parseClipFile(await r.arrayBuffer(), 'glb');
      return new Map(extractAll(file).clips.map((c) => [c.name, c]));
    })();
    return this.ualFile;
  }

  private loadUser(fileId: string, ext: ClipExt): Promise<Map<string, SourceClip>> {
    let p = this.userFiles.get(fileId);
    if (!p) {
      p = (async () => {
        const file = await parseClipFile(await this.backend.read(fileId, ext), ext);
        return new Map(extractAll(file).clips.map((c) => [String(c.index), c]));
      })();
      this.userFiles.set(fileId, p);
      p.catch(() => this.userFiles.delete(fileId));
    }
    return p;
  }

  private source(def: ClipDef): Promise<SourceClip> | null {
    const s = def.source;
    if (s.type === 'authored') return null;
    let p = this.sources.get(def.id);
    if (!p) {
      p = (s.type === 'ual' ? this.loadUal() : this.loadUser(s.file, s.ext)).then((m) => {
        const c = m.get(s.anim);
        if (!c) throw new Error(`clip ${s.anim} not found`);
        return c;
      });
      this.sources.set(def.id, p);
      p.catch(() => this.sources.delete(def.id));
    }
    return p;
  }

  target(avatar: Avatar): TargetRig {
    let t = this.targets.get(avatar);
    if (!t) {
      t = targetRig(avatar);
      this.targets.set(avatar, t);
    }
    return t;
  }

  /** The clip retargeted onto this avatar (cached). */
  async bind(avatar: Avatar, id: string): Promise<{ def: ClipDef; clip: BoundClip }> {
    const def = this.get(id);
    if (!def) throw new Error(`unknown clip ${id}`);
    let cache = this.bound.get(avatar);
    if (!cache) this.bound.set(avatar, (cache = new Map()));
    const hit = cache.get(id);
    if (hit) return { def, clip: hit };
    let clip: BoundClip;
    if (def.source.type === 'authored') {
      const name = def.source.name;
      const a = AUTHORED.find((x) => x.name === name);
      if (!a) throw new Error(`no authored clip ${name}`);
      clip = bakeAuthored(a, this.target(avatar));
    } else {
      const src = await this.source(def)!;
      clip = bindClip(src, this.target(avatar), { rootMotion: def.rootMotion });
    }
    cache.set(id, clip);
    return { def, clip };
  }

  /**
   * Import a file: parse it (so a bad file is refused before it is stored),
   * store a copy, and add one catalogue entry per animation.
   */
  async importFile(name: string, bytes: ArrayBuffer, path: string | null): Promise<UserClipEntry[]> {
    const ext = extOf(name);
    if (!ext) throw new Error('clips must be .fbx or .glb');
    const file = await parseClipFile(bytes.slice(0), ext);
    if (!file.clips.length) throw new Error(`${name}: no animations in the file`);
    const { clips, errors } = extractAll(file);
    if (!clips.length) throw new Error(`${name}: ${errors[0] ?? 'no usable animation'}`);
    const id = await sha256Hex(bytes);
    if (path && this.backend.importPath) await this.backend.importPath(path, id, ext);
    else await this.backend.write(id, ext, new Uint8Array(bytes));
    const base = name.replace(/\.(fbx|glb)$/i, '');
    const added: UserClipEntry[] = [];
    clips.forEach((c) => {
      const entryId = `user:${id}:${c.index}`;
      if (this.user.some((e) => e.id === entryId)) return;
      const anim = c.name;
      const generic = !anim || /mixamo\.com|^take|^animation|^armature/i.test(anim);
      const label = (clips.length === 1 || generic ? base : `${base}: ${anim}`).toUpperCase();
      added.push({ id: entryId, file: id, ext, anim: String(c.index), label, kind: guessKind(`${base} ${anim}`), rig: c.rig, duration: (c.frames - 1) / c.fps });
    });
    // Cache what we just parsed.
    this.userFiles.set(id, Promise.resolve(new Map(clips.map((c) => [String(c.index), c]))));
    this.user.push(...added);
    await this.backend.saveIndex(this.user);
    this.onChange();
    return added;
  }

  async remove(entryId: string): Promise<void> {
    const e = this.user.find((x) => x.id === entryId);
    if (!e) return;
    this.user = this.user.filter((x) => x.id !== entryId);
    this.sources.delete(entryId);
    delete this.options[entryId];
    if (!this.user.some((x) => x.file === e.file)) {
      this.userFiles.delete(e.file);
      await this.backend.remove(e.file).catch((err) => console.warn('[clips] remove failed', err));
    }
    await this.backend.saveIndex(this.user);
    this.onChange();
  }

  renameUser(entryId: string, label: string): void {
    const e = this.user.find((x) => x.id === entryId);
    if (!e) return;
    e.label = label.toUpperCase();
    void this.backend.saveIndex(this.user);
    this.onChange();
  }

  setKind(entryId: string, kind: 'idle' | 'emote'): void {
    const e = this.user.find((x) => x.id === entryId);
    if (!e) return;
    e.kind = kind;
    void this.backend.saveIndex(this.user);
    this.onChange();
  }
}

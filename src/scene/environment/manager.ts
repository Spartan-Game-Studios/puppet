/**
 * EnvironmentManager: puts the avatar in a lit 3D scene. It owns the scene's
 * group, a key/fill/rim/ambient light rig, fog, the ground shadow, camera
 * sway and HIGH-quality extras (shadow map, depth of field).
 *
 * Glows (sun, fireflies, neon, lamps) are painted with additive geometry
 * rather than a bloom pass: a full-resolution HDR composer measured ~4 ms at
 * 1080p on an M3 Pro and halved MediaPipe's GPU throughput. The only post
 * effect is depth of field (dof.ts), off by default.
 *
 * It plugs into the Viewer through `viewer.renderHook` only while active, and
 * restores everything it changed when deactivated, so the flat COLOUR / CLEAR
 * / IMAGE backgrounds behave exactly as before.
 */
import {
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PCFShadowMap,
  PlaneGeometry,
  Texture,
  Vector2,
  Vector3,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { Viewer } from '../viewer';
import {
  DEFAULT_LOOK,
  DEFAULT_PLACEMENT,
  fogDensity,
  resolveRig,
  swayOffset,
  temperatureTint,
  type EnvId,
  type EnvLook,
  type EnvQuality,
  type LightSpec,
  type Placement,
} from './look';
import { blobTexture, skyDome } from './parts';
import { PRESET_BUILDERS, type BuiltEnv } from './presets';
import { CUSTOM_RIG } from './rigs';
import { ShadowProxy } from './shadowProxy';
import { DepthOfField } from './dof';
import type { Avatar } from '../avatar';
import type { CustomScene, CustomSky } from './custom';

export interface EnvState {
  id: EnvId;
  quality: EnvQuality;
  look: EnvLook;
  placement: Placement;
}

/** Rough cost of a frame, for the bench script and the debug bar. */
export interface EnvFrameInfo {
  calls: number;
  triangles: number;
  post: string;
}

export class EnvironmentManager {
  active = false;
  readonly info: EnvFrameInfo = { calls: 0, triangles: 0, post: '-' };
  private readonly viewer: Viewer;
  private readonly root = new Group();
  private readonly key = new DirectionalLight();
  private readonly fill = new DirectionalLight();
  private readonly rim = new DirectionalLight();
  private readonly hemi = new HemisphereLight();
  private readonly lights = new Group();
  private readonly blob: Mesh;
  private built: BuiltEnv | null = null;
  private builtId: EnvId | null = null;
  private customScene: CustomScene | null = null;
  private customSky: CustomSky | null = null;
  private state: EnvState = { id: 'studio', quality: 'high', look: { ...DEFAULT_LOOK }, placement: { ...DEFAULT_PLACEMENT } };
  private saved: { fog: Scene['fog']; background: Scene['background']; shadow: boolean; clear: Color; alpha: number } | null = null;
  private shadowAvatar: Avatar | null = null;
  private readonly proxy = new ShadowProxy();
  private dof: DepthOfField | null = null;
  private readonly t0 = performance.now();
  private frameNo = 0;
  /**
   * Refresh the shadow map every Nth frame. Even with the capsule proxy, each
   * shadow pass cost MediaPipe ~8% of its throughput at every frame; at every
   * 3rd frame (20 Hz) the cost is inside measurement noise.
   */
  shadowEvery = 3;
  private last = performance.now();
  private readonly size = new Vector2();
  private readonly tmp = new Vector3();

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    this.root.name = 'environment';
    this.key.name = 'env-key';
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 3;
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -1.6;
    sc.right = sc.top = 1.6;
    sc.near = 0.5;
    sc.far = 16;
    this.hemi.position.set(0, 1, 0);
    this.lights.add(this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target, this.hemi, this.proxy.group);
    this.blob = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.5, fog: false }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;
    this.blob.name = 'env-blob-shadow';
  }

  get id(): EnvId {
    return this.state.id;
  }
  get hasCustomScene(): boolean {
    return !!this.customScene;
  }
  get customSceneSize(): Vector3 | null {
    return this.customScene?.size ?? null;
  }

  /** Apply settings. Rebuilds the scene only when the environment changes. */
  setState(s: EnvState): void {
    this.state = { ...s, look: { ...s.look }, placement: { ...s.placement } };
    if (!this.active) return;
    if (this.builtId !== s.id) this.build();
    this.applyLook();
  }

  activate(): void {
    if (this.active) return;
    const v = this.viewer;
    const r = v.renderer;
    this.saved = {
      fog: v.scene.fog,
      background: v.scene.background,
      shadow: r.shadowMap.enabled,
      clear: r.getClearColor(new Color()),
      alpha: r.getClearAlpha(),
    };
    this.active = true;
    v.defaultLights.visible = false;
    v.scene.add(this.root, this.lights, this.blob);
    v.renderHook = this.render;
    this.build();
    this.applyLook();
  }

  deactivate(): void {
    if (!this.active) return;
    const v = this.viewer;
    const r = v.renderer;
    this.active = false;
    v.renderHook = null;
    v.scene.remove(this.root, this.lights, this.blob);
    v.defaultLights.visible = true;
    this.teardownBuilt();
    this.setAvatarShadows(null);
    if (this.saved) {
      v.scene.fog = this.saved.fog;
      v.scene.background = this.saved.background;
      r.shadowMap.enabled = this.saved.shadow;
      r.shadowMap.autoUpdate = true;
      r.setClearColor(this.saved.clear, this.saved.alpha);
    }
    v.scene.environment = null;
    v.scene.backgroundIntensity = 1;
    this.disposeDof();
  }

  setCustomScene(c: CustomScene | null): void {
    if (this.customScene && this.customScene !== c) disposeTree(this.customScene.group);
    this.customScene = c;
    if (this.active && this.state.id === 'custom') this.build(), this.applyLook();
  }

  setCustomSky(s: CustomSky | null): void {
    if (this.customSky && this.customSky !== s) {
      this.customSky.probe.removeFromParent();
      this.customSky.dispose();
    }
    this.customSky = s;
    if (this.active && this.state.id === 'custom') this.build(), this.applyLook();
  }

  // ---------------------------------------------------------------- build

  private build(): void {
    this.teardownBuilt();
    const id = this.state.id;
    this.builtId = id;
    if (id === 'custom') {
      const g = new Group();
      const sky = this.customSky;
      if (!sky) g.add(skyDome({ top: 0x6b6f78, horizon: 0xb9b8b2, bottom: 0x3a3a38, exponent: 0.6 }));
      if (sky) g.add(sky.probe);
      const holder = new Group();
      holder.name = 'custom-scene';
      if (this.customScene) holder.add(this.customScene.group);
      g.add(holder);
      this.built = {
        group: g,
        background: sky ? sky.background : null,
        fog: { color: new Color(0xb9b8b2), density: 0.012 },
        rig: CUSTOM_RIG,
        practicals: [],
      };
    } else {
      this.built = PRESET_BUILDERS[id]();
    }
    for (const p of this.built.practicals) p.userData.base ??= { intensity: p.intensity, color: p.color.clone() };
    this.root.add(this.built.group);
    const v = this.viewer;
    v.scene.background = this.built.background;
    if (this.built.background instanceof Texture) {
      v.scene.environment = this.customSky?.environment ?? null;
    } else v.scene.environment = null;
    v.renderer.setClearColor(this.built.fog.color, 1);
    this.disposeDof();
  }

  private teardownBuilt(): void {
    if (!this.built) return;
    const g = this.built.group;
    // Custom scene and sky belong to the manager (kept across rebuilds), so detach them first.
    if (this.customScene) this.customScene.group.removeFromParent();
    if (this.customSky) this.customSky.probe.removeFromParent();
    this.root.remove(g);
    disposeTree(g);
    this.built = null;
    this.builtId = null;
  }

  // ---------------------------------------------------------------- look

  /** Re-apply the look controls (cheap; called on every slider move). */
  applyLook(): void {
    if (!this.active || !this.built) return;
    const { look, quality, placement } = this.state;
    const v = this.viewer;
    const b = this.built;
    const rig = resolveRig(b.rig, look);
    setDir(this.key, rig.key);
    setDir(this.fill, rig.fill);
    setDir(this.rim, rig.rim);
    const sky = this.state.id === 'custom' ? this.customSky : null;
    if (sky) {
      // The HDR's own light replaces the hemisphere: normalise it to the rig's ambient level.
      this.hemi.intensity = 0;
      sky.probe.intensity = rig.ambient.intensity / sky.irradiance;
      v.scene.backgroundIntensity = Math.min(4, 0.55 / sky.meanLuminance);
      v.scene.environmentIntensity = Math.min(4, 0.6 / sky.meanLuminance) * look.intensity;
    } else {
      this.hemi.color.setRGB(...rig.ambient.sky);
      this.hemi.groundColor.setRGB(...rig.ambient.ground);
      this.hemi.intensity = rig.ambient.intensity;
      v.scene.backgroundIntensity = 1;
    }
    const tint = temperatureTint(look.temperature);
    for (const p of b.practicals) {
      const base = p.userData.base as { intensity: number; color: Color };
      p.intensity = base.intensity * look.intensity;
      p.color.copy(base.color).multiply(new Color(...tint));
    }

    const density = fogDensity(b.fog.density, look.fog);
    if (density > 0) {
      if (v.scene.fog instanceof FogExp2) {
        v.scene.fog.color.copy(b.fog.color);
        v.scene.fog.density = density;
      } else v.scene.fog = new FogExp2(b.fog.color.getHex(), density);
    } else v.scene.fog = null;

    // Shadows: real shadow map at HIGH, soft blob at LOW (and a faint contact blob at HIGH).
    const high = quality === 'high';
    v.renderer.shadowMap.enabled = high && look.shadow;
    v.renderer.shadowMap.type = PCFShadowMap;
    this.key.castShadow = high && look.shadow;
    this.proxy.group.visible = high && look.shadow;
    this.blob.visible = look.shadow;
    (this.blob.material as MeshBasicMaterial).opacity = high ? 0.32 : 0.55;

    this.root.position.y = -look.floor;
    const holder = b.group.getObjectByName('custom-scene');
    if (holder) {
      holder.scale.setScalar(placement.scale);
      holder.position.set(placement.x, placement.y, placement.z);
      holder.rotation.y = (placement.rotY * Math.PI) / 180;
    }
  }

  // ---------------------------------------------------------------- frame

  /** The avatar casts its shadow through a capsule proxy (see shadowProxy.ts), never its own meshes. */
  private setAvatarShadows(a: Avatar | null): void {
    this.shadowAvatar = a;
    this.proxy.setAvatar(a);
  }

  private wantDof(): boolean {
    return this.state.quality === 'high' && this.state.look.dof;
  }

  private disposeDof(): void {
    this.dof?.dispose();
    this.dof = null;
    this.info.post = '-';
  }

  private readonly render = (r: WebGLRenderer, scene: Scene, camera: Camera): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    const avatar = this.viewer.avatar;
    if ((avatar ?? null) !== this.shadowAvatar) this.setAvatarShadows(avatar ?? null);
    this.proxy.update();

    // Ground shadow and shadow camera follow the hips.
    const hips = avatar?.bone('hips');
    const at = hips ? hips.getWorldPosition(this.tmp) : this.tmp.set(0, 1, 0);
    this.blob.position.set(at.x, 0.004, at.z);
    const s = avatar ? 0.95 : 0;
    this.blob.scale.set(s, s, 1);
    for (const l of [this.key, this.fill, this.rim]) {
      l.target.position.set(at.x, 1, at.z);
      l.position.copy(l.target.position).addScaledVector(l.userData.dir as Vector3, 6);
    }

    r.getDrawingBufferSize(this.size);
    this.built?.update?.(t, dt, this.size.y);
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = this.frameNo++ % this.shadowEvery === 0;

    // Idle sway: offset the camera for this frame only, so OrbitControls never sees it.
    const sway = this.state.look.sway;
    const cam = camera as Camera & { position: Vector3 };
    const p0 = sway ? cam.position.clone() : null;
    const q0 = sway ? cam.quaternion.clone() : null;
    if (sway) {
      const o = swayOffset(t);
      cam.translateX(o.x);
      cam.translateY(o.y);
      cam.rotateY(o.yaw);
      cam.updateMatrixWorld();
    }

    if (this.wantDof()) {
      this.dof ??= new DepthOfField();
      this.info.post = 'DOF';
      if (avatar) this.dof.focus = cam.position.distanceTo(avatar.headPosition()) + 0.15;
      this.dof.render(r, scene, camera);
    } else {
      if (this.dof) this.disposeDof();
      r.render(scene, camera);
    }
    this.info.calls = r.info.render.calls;
    this.info.triangles = r.info.render.triangles;

    if (p0 && q0) {
      cam.position.copy(p0);
      cam.quaternion.copy(q0);
      cam.updateMatrixWorld();
    }
  };
}

function setDir(l: DirectionalLight, spec: LightSpec): void {
  l.color.setRGB(...spec.color);
  l.intensity = spec.intensity * Math.PI;
  l.userData.dir = new Vector3(...spec.dir).normalize();
}

function disposeTree(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
    const mats = (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) as Material[];
    for (const mat of mats) {
      if (!o.userData.keepTexture) for (const val of Object.values(mat)) if (val instanceof Texture) val.dispose();
      const u = (mat as { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (u) for (const x of Object.values(u)) if (x.value instanceof Texture) x.value.dispose();
      mat.dispose();
    }
  });
}

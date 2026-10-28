/**
 * The built-in environments. Every one is built procedurally from three.js
 * primitives, shaders and canvas textures: no files, no downloads.
 *
 * Space: the avatar stands at the origin facing +z (towards the camera), its
 * feet on y = 0. Scenery goes mostly behind it (−z). Each builder returns its
 * group plus the lighting and fog it wants; the EnvironmentManager owns
 * the actual lights, so the look controls can restyle them.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type ColorRepresentation,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { EnvPresetId, RigSpec } from './look';
import { PRESET_RIGS } from './rigs';
import { coveProfile, fbm, glowSprite, mistTexture, mix255, paintTexture, profileSheet, rng, skyDome } from './parts';

export interface BuiltEnv {
  group: Group;
  /** Flat background colour, or null when the group has its own sky dome. */
  background: Color | Texture | null;
  fog: { color: Color; density: number };
  rig: RigSpec;
  /** Lamps in the scene. Their intensity follows the INTENSITY slider. */
  practicals: PointLight[];
  /** Per-frame animation; t in seconds, height = drawing-buffer height in pixels. */
  update?(t: number, dt: number, height: number): void;
}

/** Colour a geometry with one flat vertex colour (for merged meshes). */
function paint(g: BufferGeometry, hex: ColorRepresentation): BufferGeometry {
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new BufferAttribute(a, 3));
  return g;
}

const floorFlag = (m: Mesh) => {
  m.receiveShadow = true;
  return m;
};

// ================================================================ STUDIO
function studio(): BuiltEnv {
  const g = new Group();
  const tex = paintTexture(
    256,
    (u, v) => {
      const n = fbm(u * 8, v * 8, 3, 11, 8);
      const c = 214 + (n - 0.5) * 16;
      return [c, c - 1, c - 4];
    },
    { repeat: [0.25, 0.25] },
  );
  const sheet = floorFlag(
    new Mesh(profileSheet(coveProfile(9, -3.6, 2.4, 12), 26, 1), new MeshStandardMaterial({ map: tex, roughness: 0.94 })),
  );
  g.add(sheet);

  // Two softbox stands that frame the shot.
  const metal = new MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5, metalness: 0.6 });
  const box = new MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
  const diff = new MeshBasicMaterial({ color: 0xfffbf2 });
  for (const side of [-1, 1]) {
    const s = new Group();
    const pole = new Mesh(new CylinderGeometry(0.015, 0.015, 1.9, 6), metal);
    pole.position.y = 0.95;
    s.add(pole);
    for (let k = 0; k < 3; k++) {
      // Tripod leg from the pole (0.45 m up) to the floor.
      const a = (k / 3) * Math.PI * 2 + 0.5;
      const top = new Vector3(0, 0.45, 0);
      const foot = new Vector3(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32);
      const dir = foot.clone().sub(top);
      const leg = new Mesh(new CylinderGeometry(0.012, 0.012, dir.length(), 5), metal);
      leg.position.copy(top).add(foot).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
      s.add(leg);
    }
    const head = new Group();
    const shell = new Mesh(new BoxGeometry(0.7, 0.9, 0.22), box);
    const face = new Mesh(new PlaneGeometry(0.64, 0.84), diff);
    face.position.z = 0.111;
    head.add(shell, face);
    head.position.y = 2.0;
    head.rotation.set(-0.3, side * -0.45, 0);
    s.add(head);
    s.position.set(side * 1.55, 0, -2.4);
    g.add(s);
  }

  return {
    group: g,
    background: new Color(0xd6d4cf),
    fog: { color: new Color(0xd6d4cf), density: 0.03 },
    rig: PRESET_RIGS.studio,
    practicals: [],
  };
}

// ================================================================ COSY ROOM
function room(): BuiltEnv {
  const g = new Group();
  const R = rng(7);

  const planks = paintTexture(
    512,
    (u, v) => {
      const row = Math.floor(v * 8);
      const shade = 0.82 + 0.18 * ((row * 0.618) % 1);
      const grain = fbm(u * 3 + row * 9.1, v * 64, 3, 5);
      const seam = (v * 8) % 1 < 0.025 ? 0.55 : 1;
      const k = shade * (0.75 + 0.35 * grain) * seam;
      return [150 * k, 98 * k, 62 * k];
    },
    { repeat: [0.6, 0.6] },
  );
  const floor = floorFlag(new Mesh(new PlaneGeometry(9, 9), new MeshStandardMaterial({ map: planks, roughness: 0.7 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = 1;
  g.add(floor);

  const paper = paintTexture(
    256,
    (u, v) => {
      const stripe = Math.abs(((u * 8) % 1) - 0.5) < 0.12 ? 0.92 : 1;
      const n = 0.96 + 0.06 * fbm(u * 16, v * 16, 2, 3, 16);
      const k = stripe * n;
      return [146 * k, 158 * k, 128 * k];
    },
    { repeat: [1.2, 1] },
  );
  const wallMat = new MeshStandardMaterial({ map: paper, roughness: 0.95 });
  const back = new Mesh(new PlaneGeometry(9, 3.2), wallMat);
  back.position.set(1, 1.6, -2.4);
  const left = new Mesh(new PlaneGeometry(6, 3.2), wallMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-1.9, 1.6, 0.6);
  g.add(back, left);

  // Wainscot and skirting.
  const wood = new MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.6 });
  const wainB = new Mesh(new BoxGeometry(9, 0.9, 0.04), wood);
  wainB.position.set(1, 0.45, -2.38);
  const wainL = new Mesh(new BoxGeometry(0.04, 0.9, 6), wood);
  wainL.position.set(-1.88, 0.45, 0.6);
  const rail = new Mesh(new BoxGeometry(9, 0.05, 0.07), wood);
  rail.position.set(1, 0.92, -2.36);
  g.add(wainB, wainL, rail);

  // Window with an evening sky.
  const sky = paintTexture(128, (_u, v) => mix255(0x1d2b5a, 0xf4a35c, v ** 1.6));
  const win = new Mesh(new PlaneGeometry(1.1, 1.3), new MeshBasicMaterial({ map: sky }));
  win.position.set(1.25, 1.65, -2.39);
  g.add(win);
  const frame = new MeshStandardMaterial({ color: 0xf1ece2, roughness: 0.5 });
  const bars: Array<[number, number, number, number]> = [
    [1.25, 2.32, 1.24, 0.07],
    [1.25, 0.98, 1.24, 0.07],
    [0.67, 1.65, 0.07, 1.4],
    [1.83, 1.65, 0.07, 1.4],
    [1.25, 1.65, 0.04, 1.3],
    [1.25, 1.65, 1.1, 0.04],
  ];
  for (const [x, y, w, h] of bars) {
    const b = new Mesh(new BoxGeometry(w, h, 0.06), frame);
    b.position.set(x, y, -2.36);
    g.add(b);
  }
  const curtainTex = paintTexture(128, (u) => {
    const k = 0.75 + 0.25 * Math.cos(u * Math.PI * 12);
    return [128 * k, 52 * k, 40 * k];
  });
  for (const x of [0.42, 2.08]) {
    const c = new Mesh(new PlaneGeometry(0.42, 2.2), new MeshStandardMaterial({ map: curtainTex, roughness: 1 }));
    c.position.set(x, 1.45, -2.3);
    g.add(c);
  }

  // Bookshelf.
  const shelfWood = new MeshStandardMaterial({ color: 0x3d281b, roughness: 0.7 });
  const shelf = new Group();
  const sides: Array<[number, number, number, number, number, number]> = [
    [-0.5, 1.0, 0, 0.04, 2.0, 0.32],
    [0.5, 1.0, 0, 0.04, 2.0, 0.32],
    [0, 1.0, -0.15, 1.04, 2.0, 0.02],
  ];
  for (let i = 0; i <= 4; i++) sides.push([0, 0.04 + i * 0.48, 0, 1.0, 0.03, 0.32]);
  for (const [x, y, z, w, h, d] of sides) {
    const m = new Mesh(new BoxGeometry(w, h, d), shelfWood);
    m.position.set(x, y, z);
    shelf.add(m);
  }
  const bookGeo = new BoxGeometry(1, 1, 1);
  bookGeo.translate(0, 0.5, 0);
  const books = new InstancedMesh(bookGeo, new MeshStandardMaterial({ roughness: 0.8 }), 80);
  const palette = [0x7a2e2e, 0x2e4a6b, 0x3d5c3a, 0xb08d57, 0x5b3a5e, 0xd8cbb0, 0x2a2a2a, 0x8c5a2b];
  const m4 = new Matrix4();
  const q = new Quaternion();
  let n = 0;
  for (let s = 0; s < 4; s++) {
    let x = -0.47;
    while (x < 0.43 && n < 80) {
      const w = 0.025 + R() * 0.035;
      const h = 0.26 + R() * 0.16;
      const lean = R() < 0.08 ? 0.25 : 0;
      q.setFromAxisAngle(new Vector3(0, 0, 1), -lean);
      m4.compose(new Vector3(x + w / 2, 0.055 + s * 0.48, -0.02), q, new Vector3(w, h, 0.2 + R() * 0.05));
      books.setMatrixAt(n, m4);
      books.setColorAt(n, new Color(palette[Math.floor(R() * palette.length)]));
      n++;
      x += w + (R() < 0.1 ? 0.06 : 0.002);
    }
  }
  books.count = n;
  shelf.add(books);
  shelf.position.set(-1.1, 0, -2.2);
  g.add(shelf);

  // Floor lamp (a real light).
  const lamp = new Group();
  const brass = new MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.35, metalness: 0.8 });
  const pole = new Mesh(new CylinderGeometry(0.015, 0.015, 1.55, 8), brass);
  pole.position.y = 0.78;
  const foot = new Mesh(new CylinderGeometry(0.16, 0.18, 0.03, 16), brass);
  const shade = new Mesh(
    new CylinderGeometry(0.16, 0.26, 0.3, 20, 1, true),
    new MeshBasicMaterial({ color: 0xffd9a0, side: DoubleSide }),
  );
  shade.position.y = 1.62;
  const bulb = new PointLight(0xffb46b, 2.2, 6, 2);
  bulb.position.y = 1.55;
  const halo = glowSprite(0xffb46b, 1.1, 0.45);
  halo.position.y = 1.6;
  lamp.add(pole, foot, shade, bulb, halo);
  lamp.position.set(-1.45, 0, -1.4);
  g.add(lamp);

  // Rug.
  const rugTex = paintTexture(256, (u, v) => {
    const b = Math.min(u, v, 1 - u, 1 - v);
    if (b < 0.06) return [120, 40, 32];
    if (b < 0.09) return [214, 190, 150];
    const d = (Math.abs(u - 0.5) + Math.abs(v - 0.5)) * 6;
    return d % 1 < 0.5 ? [150, 56, 44] : [92, 40, 40];
  });
  const rug = floorFlag(new Mesh(new PlaneGeometry(2.4, 1.6), new MeshStandardMaterial({ map: rugTex, roughness: 1 })));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(0, 0.004, -0.3);
  g.add(rug);

  // Plant.
  const plant = new Group();
  const pot = new Mesh(new CylinderGeometry(0.17, 0.13, 0.32, 14), new MeshStandardMaterial({ color: 0xa65a3a, roughness: 0.9 }));
  pot.position.y = 0.16;
  plant.add(pot);
  const leafMat = new MeshStandardMaterial({ color: 0x3f6b35, roughness: 0.8, side: DoubleSide });
  for (let i = 0; i < 9; i++) {
    const leaf = new Mesh(new SphereGeometry(0.1, 8, 6), leafMat);
    leaf.scale.set(0.55, 2.6, 0.18);
    const a = (i / 9) * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.08, 0.55, Math.sin(a) * 0.08);
    leaf.rotation.set(Math.sin(a) * 0.5, a, -Math.cos(a) * 0.5);
    plant.add(leaf);
  }
  plant.position.set(2.25, 0, -2.0);
  g.add(plant);

  return {
    group: g,
    background: new Color(0x241a14),
    fog: { color: new Color(0x2e2219), density: 0.015 },
    rig: PRESET_RIGS.room,
    practicals: [bulb],
  };
}

// ================================================================ MOOR AT DUSK
function moor(): BuiltEnv {
  const g = new Group();
  const R = rng(19);
  const sunDir = new Vector3(-0.55, 0.05, -1).normalize();
  g.add(
    skyDome({
      top: 0x232a4f,
      horizon: 0xe98a5c,
      bottom: 0x2e2530,
      exponent: 0.42,
      sunDir,
      sunColor: 0xffb070,
      sunSize: 0.9993,
      sunGlow: 1.1,
    }),
  );

  // Rolling ground: flat where the avatar stands, hills further out.
  const ground = new PlaneGeometry(90, 90, 110, 110);
  ground.rotateX(-Math.PI / 2);
  const p = ground.getAttribute('position');
  const cols = new Float32Array(p.count * 3);
  const heather = new Color(0x4e3846);
  const grass = new Color(0x4f5a33);
  const dry = new Color(0x77673f);
  const tmp = new Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z + 1.5);
    const flat = Math.min(1, Math.max(0, (r - 3) / 9));
    const far = Math.min(1, Math.max(0, (r - 14) / 26));
    const h = (fbm(x * 0.05, z * 0.05, 4, 7) - 0.45) * 5 * flat + far * far * 7 * fbm(x * 0.03 + 9, z * 0.03, 3, 2) + (fbm(x * 0.6, z * 0.6, 2, 4) - 0.5) * 0.12;
    p.setY(i, h);
    const n = fbm(x * 0.18, z * 0.18, 3, 21);
    tmp.copy(grass).lerp(heather, Math.min(1, Math.max(0, n * 1.8 - 0.5)));
    tmp.lerp(dry, Math.max(0, fbm(x * 0.4, z * 0.4, 2, 9) - 0.6) * 1.5);
    cols.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  ground.setAttribute('color', new BufferAttribute(cols, 3));
  ground.computeVertexNormals();
  g.add(floorFlag(new Mesh(ground, new MeshLambertMaterial({ vertexColors: true }))));

  // The stone circle: rough standing stones, an open arc on the camera side.
  const stoneTex = paintTexture(
    256,
    (u, v) => {
      const n = fbm(u * 10, v * 10, 5, 31, 10);
      const base = mix255(0x56575a, 0x8d8c86, n);
      const spots = fbm(u * 18 + 3, v * 18, 3, 8, 18);
      const l = Math.min(1, Math.max(0, (spots - 0.64) * 4)) * 0.6; // sparse pale lichen
      const lichen = [176, 172, 140];
      return [0, 1, 2].map((i) => base[i] + (lichen[i] - base[i]) * l) as [number, number, number];
    },
    { repeat: [1, 1] },
  );
  const stones: BufferGeometry[] = [];
  const center = new Vector3(0, 0, -1.6);
  const count = 13;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + 0.2;
    const pos = new Vector3(Math.sin(a) * 4.6, 0, Math.cos(a) * 4.6).add(center);
    if (pos.z > 0.8 && Math.abs(pos.x) < 4.2) continue; // keep the camera side open
    const tall = 1.3 + R() * 1.3;
    const geo = new BoxGeometry(0.55 + R() * 0.35, tall, 0.3 + R() * 0.2, 2, 4, 2);
    const gp = geo.getAttribute('position');
    for (let k = 0; k < gp.count; k++) {
      const y = gp.getY(k) / tall + 0.5;
      const taper = 1 - y * 0.35;
      gp.setX(k, gp.getX(k) * taper * (0.88 + R() * 0.24));
      gp.setZ(k, gp.getZ(k) * taper * (0.88 + R() * 0.24));
      gp.setY(k, gp.getY(k) + (y > 0.95 ? (R() - 0.5) * 0.25 : 0));
    }
    geo.translate(0, tall / 2 - 0.15, 0);
    geo.rotateZ((R() - 0.5) * 0.12);
    geo.rotateY(a + (R() - 0.5) * 0.6);
    geo.translate(pos.x, 0, pos.z);
    stones.push(geo.toNonIndexed());
  }
  // A fallen stone.
  const fallen = new BoxGeometry(1.8, 0.45, 0.6, 3, 1, 1);
  fallen.rotateY(0.4);
  fallen.translate(3.2, 0.12, -4.4);
  stones.push(fallen.toNonIndexed());
  const stoneGeo = mergeGeometries(stones)!;
  stoneGeo.computeVertexNormals();
  const stoneMesh = new Mesh(stoneGeo, new MeshStandardMaterial({ map: stoneTex, roughness: 1, flatShading: true }));
  stoneMesh.receiveShadow = true;
  g.add(stoneMesh);

  // Drifting mist.
  const mistTex = mistTexture(5);
  const mists: Sprite[] = [];
  for (let i = 0; i < 18; i++) {
    const m = new Sprite(new SpriteMaterial({ map: mistTex, color: 0xd9b4ab, transparent: true, opacity: 0.22 + R() * 0.18, depthWrite: false }));
    const w = 6 + R() * 8;
    m.scale.set(w, w * 0.28, 1);
    m.position.set((R() - 0.5) * 36, 0.25 + R() * 1.2, -2.5 - R() * 24);
    m.userData.speed = 0.08 + R() * 0.15;
    mists.push(m);
    g.add(m);
  }

  return {
    group: g,
    background: null,
    fog: { color: new Color(0x8a6672), density: 0.045 },
    rig: PRESET_RIGS.moor,
    practicals: [],
    update(_t, dt) {
      for (const m of mists) {
        m.position.x += m.userData.speed * dt;
        if (m.position.x > 20) m.position.x -= 40;
      }
    },
  };
}

// ================================================================ NIGHT FOREST CLEARING
function forest(): BuiltEnv {
  const g = new Group();
  const R = rng(23);
  g.add(
    skyDome({
      top: 0x04070f,
      horizon: 0x15253a,
      bottom: 0x04070a,
      exponent: 0.5,
      sunDir: new Vector3(0.45, 0.5, -1).normalize(),
      sunColor: 0xdfe6ff,
      sunSize: 0.9997,
      sunGlow: 0.35,
      stars: 1,
    }),
  );

  const ground = new PlaneGeometry(90, 90, 70, 70);
  ground.rotateX(-Math.PI / 2);
  const p = ground.getAttribute('position');
  const cols = new Float32Array(p.count * 3);
  const moss = new Color(0x2c3f25);
  const dark = new Color(0x141f14);
  const tmp = new Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z + 1);
    const out = Math.min(1, Math.max(0, (r - 5) / 10));
    p.setY(i, (fbm(x * 0.08, z * 0.08, 3, 3) - 0.5) * 2.2 * out);
    tmp.copy(moss).lerp(dark, Math.min(1, out * 0.8 + fbm(x * 0.3, z * 0.3, 2, 5) * 0.4));
    cols.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  ground.setAttribute('color', new BufferAttribute(cols, 3));
  ground.computeVertexNormals();
  g.add(floorFlag(new Mesh(ground, new MeshLambertMaterial({ vertexColors: true }))));

  // Conifers: one merged low-poly tree, instanced around the clearing.
  const parts = [
    paint(new CylinderGeometry(0.12, 0.18, 1.2, 6).translate(0, 0.6, 0), 0x3a2a1e),
    paint(new ConeGeometry(1.15, 1.9, 7).translate(0, 1.7, 0), 0x18301f),
    paint(new ConeGeometry(0.9, 1.6, 7).translate(0, 2.6, 0), 0x1c3824),
    paint(new ConeGeometry(0.6, 1.3, 7).translate(0, 3.4, 0), 0x21402a),
  ].map((x) => x.toNonIndexed());
  const treeGeo = mergeGeometries(parts)!;
  treeGeo.computeVertexNormals();
  const N = 150;
  const trees = new InstancedMesh(treeGeo, new MeshLambertMaterial({ vertexColors: true, flatShading: true }), N);
  const dummy = new Object3D();
  let k = 0;
  for (let tries = 0; tries < 2000 && k < N; tries++) {
    const a = R() * Math.PI * 2;
    const r = 5.5 + Math.sqrt(R()) * 28;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r - 1;
    if (z > 1.5 && Math.abs(x) < 5) continue;
    const s = 0.9 + R() * 1.1;
    dummy.position.set(x, -0.1, z);
    dummy.rotation.set(0, R() * 6.28, 0);
    dummy.scale.set(s, s * (0.9 + R() * 0.5), s);
    dummy.updateMatrix();
    trees.setMatrixAt(k++, dummy.matrix);
  }
  trees.count = k;
  g.add(trees);

  // Fallen log and a few rocks.
  const log = new Mesh(new CylinderGeometry(0.18, 0.22, 2.4, 9), new MeshLambertMaterial({ color: 0x3b2c22 }));
  log.rotation.set(0, 0.5, Math.PI / 2);
  log.position.set(2.2, 0.18, -2.4);
  g.add(log);
  const rockMat = new MeshLambertMaterial({ color: 0x3d4440, flatShading: true });
  for (const [x, z, s] of [[-2.4, -2.8, 0.45], [-1.9, -3.4, 0.3], [2.9, -1.2, 0.35]] as const) {
    const rock = new Mesh(new SphereGeometry(1, 6, 4), rockMat);
    rock.scale.set(s * 1.3, s * 0.7, s);
    rock.position.set(x, s * 0.25, z);
    g.add(rock);
  }

  // Fireflies: GPU-animated points.
  const F = 180;
  const pos = new Float32Array(F * 3);
  const seed = new Float32Array(F * 2);
  for (let i = 0; i < F; i++) {
    pos.set([(R() - 0.5) * 12, 0.2 + R() * 2.4, -9 + R() * 10.5], i * 3);
    seed.set([R() * 100, 0.4 + R() * 0.8], i * 2);
  }
  const fg = new BufferGeometry();
  fg.setAttribute('position', new Float32BufferAttribute(pos, 3));
  fg.setAttribute('seed', new Float32BufferAttribute(seed, 2));
  const fmat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { time: { value: 0 }, scale: { value: 1 }, color: { value: new Color(0xd6ff7a) } },
    vertexShader: /* glsl */ `
      attribute vec2 seed;
      uniform float time, scale;
      varying float vGlow;
      void main() {
        float ph = seed.x, s = seed.y;
        vec3 p = position + vec3(sin(time * s * 0.6 + ph) * 0.5, sin(time * s * 0.9 + ph * 2.0) * 0.25, cos(time * s * 0.5 + ph) * 0.5);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vGlow = pow(0.5 + 0.5 * sin(time * s * 2.2 + ph * 3.0), 4.0);
        gl_PointSize = scale * (8.0 + 18.0 * vGlow) * (2.0 / max(0.5, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying float vGlow;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        a = a * a * (0.15 + 0.85 * vGlow);
        gl_FragColor = vec4(color * a * 1.6, a);
        #include <colorspace_fragment>
      }`,
  });
  const flies = new Points(fg, fmat);
  flies.frustumCulled = false;
  g.add(flies);

  return {
    group: g,
    background: null,
    fog: { color: new Color(0x0c1622), density: 0.06 },
    rig: PRESET_RIGS.forest,
    practicals: [],
    update(t, _dt, height) {
      fmat.uniforms.time.value = t;
      // Point size is in device pixels: follow the drawing-buffer height.
      fmat.uniforms.scale.value = (height / 1080) * 1.6;
    },
  };
}

// ================================================================ NEON GRID
function neon(): BuiltEnv {
  const g = new Group();
  const R = rng(31);
  g.add(skyDome({ top: 0x090022, horizon: 0xff3d8b, bottom: 0x0b0020, exponent: 0.32 }));

  // Striped sun.
  const sunMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      varying vec2 vUv;
      void main() {
        vec2 c = vUv - 0.5;
        float r = length(c) * 2.0;
        if (r > 1.0) discard;
        float y = vUv.y;
        vec3 col = mix(vec3(1.0, 0.16, 0.46), vec3(1.0, 0.83, 0.1), smoothstep(0.1, 0.9, y));
        float band = fract(y * 14.0 + time * 0.25);
        float gap = mix(0.45, 0.0, smoothstep(0.05, 0.55, y));
        if (y < 0.55 && band < gap) discard;
        float edge = smoothstep(1.0, 0.97, r);
        gl_FragColor = vec4(col * 1.25, edge);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sun = new Mesh(new PlaneGeometry(18, 18), sunMat);
  sun.position.set(0, 6.5, -40);
  sun.renderOrder = -5;
  const sunGlow = glowSprite(0xff4f9a, 46, 0.55);
  sunGlow.position.set(0, 6.5, -41);
  sunGlow.renderOrder = -6;
  g.add(sunGlow, sun);

  // Ridges: dark fill with glowing edges.
  for (const [z, hgt, col] of [[-34, 6, 0x9d4dff], [-28, 3.5, 0x2de2e6]] as const) {
    const pts: Vector3[] = [];
    for (let x = -60; x <= 60; x += 2.5) {
      const valley = Math.min(1, Math.abs(x) / 14);
      pts.push(new Vector3(x, (0.3 + R() * 0.7) * hgt * valley, z + (R() - 0.5) * 2));
    }
    const fill: number[] = [];
    const idx: number[] = [];
    pts.forEach((pt, i) => {
      fill.push(pt.x, pt.y, pt.z, pt.x, -0.1, pt.z);
      if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    });
    const fg = new BufferGeometry();
    fg.setAttribute('position', new Float32BufferAttribute(fill, 3));
    fg.setIndex(idx);
    g.add(new Mesh(fg, new MeshBasicMaterial({ color: 0x14002b, side: DoubleSide })));
    const line: number[] = [];
    for (let i = 1; i < pts.length; i++) line.push(...pts[i - 1].toArray(), ...pts[i].toArray());
    const lg = new BufferGeometry();
    lg.setAttribute('position', new Float32BufferAttribute(line, 3));
    g.add(new LineSegments(lg, new LineBasicMaterial({ color: col })));
  }

  // Scrolling grid floor.
  const gridMat = new ShaderMaterial({
    fog: false,
    uniforms: {
      time: { value: 0 },
      base: { value: new Color(0x0e0326) },
      lineA: { value: new Color(0xff2bd6) },
      lineB: { value: new Color(0x2de2e6) },
      far: { value: new Color(0xff3d8b) },
    },
    vertexShader: /* glsl */ `varying vec3 vW; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 base, lineA, lineB, far;
      varying vec3 vW;
      float grid(float v) { float w = fwidth(v); float d = abs(fract(v - 0.5) - 0.5); return 1.0 - smoothstep(0.0, w * 1.5, d - 0.02); }
      void main() {
        float gx = grid(vW.x);
        float gz = grid(vW.z + time * 1.2);
        vec3 col = base + lineA * gz * 1.4 + lineB * gx * 0.9;
        float dist = length(vW.xz);
        col = mix(col, far * 0.55, smoothstep(12.0, 48.0, dist));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const floor = new Mesh(new PlaneGeometry(120, 120), gridMat);
  floor.rotation.x = -Math.PI / 2;
  g.add(floor);

  return {
    group: g,
    background: null,
    fog: { color: new Color(0x2b0b3f), density: 0.018 },
    rig: PRESET_RIGS.neon,
    practicals: [],
    update(t) {
      gridMat.uniforms.time.value = t;
      sunMat.uniforms.time.value = t;
    },
  };
}

// ================================================================ CONCRETE HALL
function hall(): BuiltEnv {
  const g = new Group();
  const concrete = paintTexture(
    512,
    (u, v, _x, y) => {
      const n = fbm(u * 12, v * 12, 5, 41, 12);
      const board = (y % 64) < 2 ? 0.86 : 1; // board-formed lines
      const boardShade = 0.97 + 0.06 * ((Math.floor(y / 64) * 0.618) % 1);
      const tu = (u * 4) % 1;
      const tv = (v * 4) % 1;
      const tie = Math.hypot(tu - 0.5, tv - 0.5) < 0.025 ? 0.55 : 1;
      const k = (0.62 + 0.5 * n) * board * boardShade * tie;
      return [138 * k, 137 * k, 133 * k];
    },
    { repeat: [0.25, 0.25] },
  );
  const wall = new MeshStandardMaterial({ map: concrete, roughness: 0.95 });
  const polished = paintTexture(
    512,
    (u, v) => {
      const n = fbm(u * 20, v * 20, 4, 13, 20);
      const joint = (u * 2) % 1 < 0.006 || (v * 2) % 1 < 0.006 ? 0.6 : 1;
      const k = (0.72 + 0.28 * n) * joint;
      return [132 * k, 132 * k, 130 * k];
    },
    { repeat: [1 / 6, 1 / 6] },
  );
  const W = 14;
  const D = 32;
  const H = 9;
  const floor = floorFlag(new Mesh(new PlaneGeometry(W, D), new MeshStandardMaterial({ map: polished, roughness: 0.45 })));
  floor.rotation.x = -Math.PI / 2;
  floor.position.z = -D / 2 + 6;
  const mk = (w: number, h: number, x: number, y: number, z: number, ry: number, rx = 0) => {
    const m = new Mesh(new PlaneGeometry(w, h), wall);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    g.add(m);
  };
  g.add(floor);
  mk(W, H, 0, H / 2, -D + 6, 0);
  mk(D, H, -W / 2, H / 2, -D / 2 + 6, Math.PI / 2);
  mk(D, H, W / 2, H / 2, -D / 2 + 6, -Math.PI / 2);
  mk(W, D, 0, H, -D / 2 + 6, 0, Math.PI / 2);
  mk(W, H, 0, H / 2, 6, Math.PI);

  // Columns.
  const colGeo = new BoxGeometry(0.9, H, 0.9);
  colGeo.translate(0, H / 2, 0);
  const zs = [-2.6, -8.4, -14.2, -20];
  const columns = new InstancedMesh(colGeo, wall, zs.length * 2);
  const d = new Object3D();
  let i = 0;
  for (const z of zs) {
    for (const x of [-2.9, 2.9]) {
      d.position.set(x, 0, z);
      d.updateMatrix();
      columns.setMatrixAt(i++, d.matrix);
    }
  }
  g.add(columns);

  // Ceiling light slots and the accent rule.
  const glow = new MeshBasicMaterial({ color: 0xf4f6ff });
  for (const x of [-1.4, 1.4]) {
    const s = new Mesh(new BoxGeometry(0.18, 0.04, D - 4), glow);
    s.position.set(x, H - 0.03, -D / 2 + 6);
    g.add(s);
  }
  const accent = new MeshBasicMaterial({ color: 0xff3b00 });
  const rule = new Mesh(new BoxGeometry(W - 0.02, 0.12, 0.02), accent);
  rule.position.set(0, 1.1, -D + 6.02);
  g.add(rule);
  for (const side of [-1, 1]) {
    const r2 = new Mesh(new BoxGeometry(0.02, 0.12, D), accent);
    r2.position.set(side * (W / 2 - 0.02), 1.1, -D / 2 + 6);
    g.add(r2);
  }

  // A tall slot window with a light patch on the floor.
  const slot = new Mesh(new PlaneGeometry(0.7, 7.2), new MeshBasicMaterial({ color: 0xfff6e8 }));
  slot.position.set(3.4, 4.2, -D + 6.03);
  const slotGlow = glowSprite(0xfff1dc, 5, 0.35);
  slotGlow.scale.set(3.2, 10, 1);
  slotGlow.position.set(3.4, 4.2, -D + 6.3);
  g.add(slot, slotGlow);
  const patchTex = paintTexture(128, (u, v) => {
    const a = Math.max(0, 1 - Math.abs(u - 0.5) * 2.4) * Math.max(0, 1 - Math.abs(v - 0.5) * 2) ** 0.7;
    return [255, 244, 225, Math.round(a * 55)];
  });
  const patch = new Mesh(
    new PlaneGeometry(1.4, 9),
    new MeshBasicMaterial({ map: patchTex, transparent: true, depthWrite: false, blending: AdditiveBlending }),
  );
  patch.rotation.x = -Math.PI / 2;
  patch.position.set(3.0, 0.01, -D + 11);
  g.add(patch);

  return {
    group: g,
    background: new Color(0x8f8f8b),
    fog: { color: new Color(0x9a9a96), density: 0.028 },
    rig: PRESET_RIGS.hall,
    practicals: [],
  };
}

export const PRESET_BUILDERS: Record<EnvPresetId, () => BuiltEnv> = { studio, room, moor, forest, neon, hall };

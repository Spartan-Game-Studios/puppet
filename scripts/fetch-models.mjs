// Fetches the MediaPipe model files (Apache-2.0, published by Google) into
// public/mediapipe/models and copies the tasks-vision WASM runtime out of
// node_modules into public/mediapipe/wasm. Neither is committed to git; this
// runs before every `pnpm dev` / `pnpm build` and is a no-op once cached.
//
// Every model is pinned to a versioned URL and a SHA-256, so a build can't
// silently pick up a different model.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'public', 'mediapipe', 'models');
const wasmDir = join(root, 'public', 'mediapipe', 'wasm');
const BASE = 'https://storage.googleapis.com/mediapipe-models';

export const MODELS = [
  {
    file: 'face_landmarker.task',
    url: `${BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    file: 'pose_landmarker_lite.task',
    url: `${BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
    sha256: '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a',
  },
  {
    file: 'pose_landmarker_full.task',
    url: `${BASE}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
    sha256: '5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1',
  },
  {
    file: 'hand_landmarker.task',
    url: `${BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
    sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchModel({ file, url, sha256: want }) {
  const dest = join(modelsDir, file);
  if (await exists(dest)) {
    if (sha256(await readFile(dest)) === want) return 'cached';
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`${file}: sha256 mismatch (got ${got}, want ${want})`);
  await writeFile(dest, buf);
  return `downloaded ${(buf.length / 1e6).toFixed(1)} MB`;
}

async function copyWasm() {
  const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  // The ES-module build runs in the tracking workers; the classic build is the
  // main-thread fallback (used only if workers can't start).
  for (const f of [
    'vision_wasm_module_internal.js',
    'vision_wasm_module_internal.wasm',
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
  ]) {
    await copyFile(join(src, f), join(wasmDir, f));
  }
}

await mkdir(modelsDir, { recursive: true });
await mkdir(wasmDir, { recursive: true });
for (const m of MODELS) {
  const r = await fetchModel(m);
  if (r !== 'cached') console.log(`[models] ${m.file}: ${r}`);
}
await copyWasm();

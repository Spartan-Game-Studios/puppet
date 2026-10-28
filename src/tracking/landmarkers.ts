/**
 * MediaPipe Tasks (Vision) wrapper used by the workers (and by the main-thread
 * fallback). Face, pose and hand landmarkers in VIDEO mode.
 */
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { BodyMode, FaceResult, HandResult, Pipeline, PoseResult, TrackerResult } from './protocol';

export interface LandmarkerSet {
  face?: FaceLandmarker;
  pose?: PoseLandmarker;
  /** One hand landmarker per (user) side, each fed a crop around that wrist. */
  hands?: Record<'left' | 'right', HandLandmarker>;
  delegate: 'GPU' | 'CPU';
}

export async function createLandmarkers(
  pipelines: Pipeline[],
  wasmBase: string,
  modelBase: string,
  delegate: 'GPU' | 'CPU',
  poseModel: 'lite' | 'full',
): Promise<LandmarkerSet> {
  // Workers load the ES-module WASM loader; the main thread needs the classic one.
  const inWorker = typeof document === 'undefined';
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, inWorker);
  const opts = (file: string) => ({ baseOptions: { modelAssetPath: `${modelBase}/${file}`, delegate } });
  const set: LandmarkerSet = { delegate };
  // Create all tasks concurrently: with the module loader, tasks created one
  // after another fail ("ModuleFactory not set") because the loader's global
  // is consumed by the first.
  await Promise.all([
    pipelines.includes('face') &&
      FaceLandmarker.createFromOptions(fileset, {
        ...opts('face_landmarker.task'),
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      }).then((f) => (set.face = f)),
    pipelines.includes('body') &&
      PoseLandmarker.createFromOptions(fileset, {
        ...opts(`pose_landmarker_${poseModel}.task`),
        runningMode: 'VIDEO',
        numPoses: 1,
      }).then((p) => (set.pose = p)),
    pipelines.includes('body') &&
      Promise.all(
        [0, 1].map(() =>
          HandLandmarker.createFromOptions(fileset, {
            ...opts('hand_landmarker.task'),
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: 0.4,
          }),
        ),
      ).then(([l, r]) => (set.hands = { left: l, right: r })),
  ]);
  return set;
}

function faceFrom(r: FaceLandmarkerResult, want2d: boolean): FaceResult | null {
  if (!r.faceBlendshapes?.length) return null;
  const blendshapes: Record<string, number> = {};
  for (const c of r.faceBlendshapes[0].categories) {
    if (c.categoryName && c.categoryName !== '_neutral') blendshapes[c.categoryName] = c.score;
  }
  const m = r.facialTransformationMatrixes?.[0];
  const out: FaceResult = { blendshapes, matrix: m ? Array.from(m.data) : null };
  if (want2d && r.faceLandmarks?.[0]) {
    const l = r.faceLandmarks[0];
    const a = new Float32Array(l.length * 2);
    for (let i = 0; i < l.length; i++) {
      a[2 * i] = l[i].x;
      a[2 * i + 1] = l[i].y;
    }
    out.landmarks2d = a;
  }
  return out;
}

const plain = (ls: { x: number; y: number; z: number; visibility?: number }[]) =>
  ls.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility }));

function poseFrom(r: PoseLandmarkerResult): PoseResult | null {
  if (!r.worldLandmarks?.length) return null;
  return { world: plain(r.worldLandmarks[0]), image: plain(r.landmarks[0]) };
}

const POSE_SIDE = {
  left: { elbow: 13, wrist: 15, index: 19 },
  right: { elbow: 14, wrist: 16, index: 20 },
} as const;

/** Square crop (pixels) around a wrist, from pose landmarks; null if the wrist isn't trusted. */
export function handRoi(
  pose: PoseResult,
  side: 'left' | 'right',
  width: number,
  height: number,
): { x: number; y: number; size: number } | null {
  const ix = POSE_SIDE[side];
  const w = pose.image[ix.wrist];
  const i = pose.image[ix.index];
  const e = pose.image[ix.elbow];
  if ((w.visibility ?? 1) < 0.3) return null;
  const px = (l: { x: number; y: number }) => [l.x * width, l.y * height];
  const [wx, wy] = px(w);
  const [qx, qy] = px(i);
  const [ex, ey] = px(e);
  const hand = Math.hypot(qx - wx, qy - wy);
  const fore = Math.hypot(wx - ex, wy - ey);
  const size = Math.max(96, 3.2 * hand, 0.9 * fore);
  const cx = wx + 0.8 * (qx - wx);
  const cy = wy + 0.8 * (qy - wy);
  if (cx < -size / 2 || cy < -size / 2 || cx > width + size / 2 || cy > height + size / 2) return null;
  return { x: cx - size / 2, y: cy - size / 2, size };
}

const CROP = 256;
let cropCanvas: OffscreenCanvas | null = null;
/** Consecutive misses per side; while a hand is missing, look for it only every few frames. */
const misses = { left: 0, right: 0 };
const RETRY_EVERY = 4;

function handFromCrop(
  lm: HandLandmarker,
  image: ImageBitmap | HTMLVideoElement,
  roi: { x: number; y: number; size: number },
  width: number,
  height: number,
  t: number,
  side: 'left' | 'right',
): HandResult | null {
  cropCanvas ??= new OffscreenCanvas(CROP, CROP);
  const g = cropCanvas.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, CROP, CROP);
  g.drawImage(image, roi.x, roi.y, roi.size, roi.size, 0, 0, CROP, CROP);
  const r: HandLandmarkerResult = lm.detectForVideo(cropCanvas, t);
  if (!r.landmarks?.length) return null;
  const h = r.handedness?.[0]?.[0];
  // Crop-normalized -> full-image-normalized.
  const landmarks = r.landmarks[0].map((l) => ({
    x: (roi.x + l.x * roi.size) / width,
    y: (roi.y + l.y * roi.size) / height,
    z: l.z,
    visibility: l.visibility,
  }));
  return {
    landmarks,
    worldLandmarks: plain(r.worldLandmarks[0]),
    handedness: h?.categoryName ?? 'Unknown',
    score: h?.score ?? 0,
    userSide: side,
  };
}

export function detect(
  set: LandmarkerSet,
  pipeline: Pipeline,
  image: ImageBitmap | HTMLVideoElement,
  t: number,
  mode: BodyMode,
  want2d: boolean,
): Omit<TrackerResult, 'type'> {
  const width = 'videoWidth' in image ? image.videoWidth : image.width;
  const height = 'videoHeight' in image ? image.videoHeight : image.height;
  const timings = { face: 0, pose: 0, hands: 0, total: 0 };
  const t0 = performance.now();
  if (pipeline === 'face') {
    const face = set.face ? faceFrom(set.face.detectForVideo(image, t), want2d) : null;
    timings.face = timings.total = performance.now() - t0;
    return { pipeline, t, width, height, face, timings };
  }
  const pose = set.pose ? poseFrom(set.pose.detectForVideo(image, t)) : null;
  const t1 = performance.now();
  const hands: HandResult[] = [];
  let handsRan = false;
  if (mode === 'hands' && set.hands && pose) {
    // Hands are small in a webcam frame; crop around each wrist so the hand
    // model sees them large. Each side has its own landmarker so VIDEO-mode
    // tracking stays consistent.
    for (const side of ['left', 'right'] as const) {
      const roi = handRoi(pose, side, width, height);
      if (!roi) continue;
      if (misses[side] > 0 && misses[side] % RETRY_EVERY !== 0) {
        misses[side]++;
        continue;
      }
      handsRan = true;
      const h = handFromCrop(set.hands[side], image, roi, width, height, t, side);
      if (h) {
        hands.push(h);
        misses[side] = 0;
      } else misses[side]++;
    }
  }
  const t2 = performance.now();
  timings.pose = t1 - t0;
  timings.hands = t2 - t1;
  timings.total = t2 - t0;
  return { pipeline, t, width, height, pose, hands, handsRan, timings };
}

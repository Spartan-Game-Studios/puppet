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
import type { Landmark, Side } from '../core/bodySolver';
import type { BodyMode, FaceResult, HandResult, Pipeline, PoseResult, TrackerResult } from './protocol';
import { roiFromLandmarks, roiFromPose, sameHand, stabilizeRoi, wristDistance, type Roi } from './handRoi';

export interface LandmarkerSet {
  face?: FaceLandmarker;
  pose?: PoseLandmarker;
  /** One hand landmarker per (user) side, each fed a crop around that wrist. */
  hands?: Record<'left' | 'right', HandLandmarker>;
  handTracker?: HandCropTracker;
  delegate: 'GPU' | 'CPU';
  /** For swapping the pose model at run time. */
  fileset?: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
  modelBase?: string;
  poseModel?: 'lite' | 'full';
}

/** Swap the pose model (lite <-> full) in place; the old one is closed once the new one is ready. */
export async function setPoseModel(set: LandmarkerSet, poseModel: 'lite' | 'full'): Promise<void> {
  if (!set.pose || !set.fileset || set.poseModel === poseModel) return;
  const next = await PoseLandmarker.createFromOptions(set.fileset, {
    baseOptions: { modelAssetPath: `${set.modelBase}/pose_landmarker_${poseModel}.task`, delegate: set.delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  const old = set.pose;
  set.pose = next;
  set.poseModel = poseModel;
  old.close();
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
  const set: LandmarkerSet = { delegate, fileset, modelBase, poseModel };
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
    pipelines.includes('hands') &&
      Promise.all(
        [0, 1].map(() =>
          HandLandmarker.createFromOptions(fileset, {
            ...opts('hand_landmarker.task'),
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: 0.3,
            minHandPresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
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

interface HandSideState {
  /** Last landmarks found (normalized image coords) and when. */
  last: Landmark[] | null;
  lastT: number;
  /** The crop used last time (kept while the hand stays inside it). */
  roi: Roi | null;
  misses: number;
  /** What happened on the last frame (debug readout / harness). */
  status: 'skip' | 'no-roi' | 'miss' | 'other-hand' | 'duplicate' | 'tracked' | 'found';
}

/** A hand found this recently is tracked from its own landmarks rather than re-found from the pose. */
const TRACK_MS = 250;
const CROP = 256;

/**
 * Hand detection on crops: one HandLandmarker per user side, each fed a
 * square crop around that hand. While a hand is being tracked the crop
 * follows its last landmarks (and holds still while the hand stays inside
 * it, so MediaPipe's own VIDEO-mode tracking stays valid); otherwise it is
 * re-found from the pose's wrist, alternating a normal and a wide crop.
 * A found hand must match its own side's pose wrist better than the other
 * side's, and if both crops found the same hand only the better match keeps it.
 */
export class HandCropTracker {
  readonly state: Record<Side, HandSideState> = {
    left: { last: null, lastT: -1e9, roi: null, misses: 0, status: 'skip' },
    right: { last: null, lastT: -1e9, roi: null, misses: 0, status: 'skip' },
  };
  private canvas: OffscreenCanvas | null = null;

  constructor(private readonly landmarkers: Record<Side, HandLandmarker>) {}

  run(image: ImageBitmap | HTMLVideoElement, width: number, height: number, t: number, pose: PoseResult | null): { hands: HandResult[]; ran: boolean } {
    const found: Partial<Record<Side, HandResult>> = {};
    let ran = false;
    for (const side of ['left', 'right'] as const) {
      const st = this.state[side];
      const tracking = st.last !== null && t - st.lastT < TRACK_MS;
      let roi: Roi | null = null;
      if (tracking) {
        roi = stabilizeRoi(st.roi, roiFromLandmarks(st.last!, width, height, 2.0));
      } else if (pose) {
        const vis = pose.image[side === 'left' ? 15 : 16]?.visibility ?? 1;
        // Wrist probably out of view: look only now and then.
        if (vis < 0.5 && st.misses % 4 !== 0) {
          st.misses++;
          st.status = 'skip';
          continue;
        }
        roi = roiFromPose(pose.image, side, width, height, st.misses % 2 ? 1.5 : 1);
      }
      if (!roi) {
        st.misses++;
        st.roi = null;
        st.status = 'no-roi';
        continue;
      }
      ran = true;
      let h = this.detectIn(side, image, roi, width, height, t);
      if (!h && tracking && pose) {
        // Lost it inside the tracking crop: look again where the pose says the hand is.
        const again = roiFromPose(pose.image, side, width, height, 1.2);
        if (again) {
          h = this.detectIn(side, image, again, width, height, t + 0.5);
          if (h) roi = again;
        }
      }
      if (h && pose) {
        // The crop may hold the other hand (crossed arms, hands together).
        const own = wristDistance(h.landmarks, pose.image, side, width, height);
        const other = wristDistance(h.landmarks, pose.image, side === 'left' ? 'right' : 'left', width, height);
        if (own > 1.2 && other < 0.6 * own) {
          st.status = 'other-hand';
          st.misses++;
          st.roi = null;
          st.last = null;
          continue;
        }
      }
      if (h) {
        found[side] = h;
        st.last = h.landmarks;
        st.lastT = t;
        st.roi = roi;
        st.misses = 0;
        st.status = tracking ? 'tracked' : 'found';
      } else {
        st.status = 'miss';
        st.misses++;
        st.roi = null;
        if (t - st.lastT >= TRACK_MS) st.last = null;
      }
    }
    if (found.left && found.right && sameHand(found.left.landmarks, found.right.landmarks, width, height)) {
      const d = (s: Side) => wristDistance(found[s]!.landmarks, pose?.image, s, width, height);
      const drop: Side = d('left') <= d('right') ? 'right' : 'left';
      delete found[drop];
      this.state[drop].status = 'duplicate';
      this.state[drop].last = null;
      this.state[drop].roi = null;
    }
    return { hands: (['left', 'right'] as const).flatMap((s) => (found[s] ? [found[s]!] : [])), ran };
  }

  private detectIn(side: Side, image: ImageBitmap | HTMLVideoElement, roi: Roi, width: number, height: number, t: number): HandResult | null {
    this.canvas ??= new OffscreenCanvas(CROP, CROP);
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, CROP, CROP);
    g.drawImage(image, roi.x, roi.y, roi.size, roi.size, 0, 0, CROP, CROP);
    const r: HandLandmarkerResult = this.landmarkers[side].detectForVideo(this.canvas, t);
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
}

export function detect(
  set: LandmarkerSet,
  pipeline: Pipeline,
  image: ImageBitmap | HTMLVideoElement,
  t: number,
  mode: BodyMode,
  want2d: boolean,
  /** 'hands' pipeline: the latest pose, to find hands that aren't being tracked yet. */
  poseHint: PoseResult | null = null,
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
  if (pipeline === 'hands') {
    let hands: HandResult[] = [];
    let handsRan = false;
    if (mode === 'hands' && set.hands) {
      set.handTracker ??= new HandCropTracker(set.hands);
      ({ hands, ran: handsRan } = set.handTracker.run(image, width, height, t, poseHint));
    }
    timings.hands = timings.total = performance.now() - t0;
    return { pipeline, t, width, height, hands, handsRan, timings };
  }
  const pose = set.pose ? poseFrom(set.pose.detectForVideo(image, t)) : null;
  const t1 = performance.now();
  let hands: HandResult[] = [];
  let handsRan = false;
  // Main-thread fallback (one set does everything): hands right after the pose.
  if (mode === 'hands' && set.hands) {
    set.handTracker ??= new HandCropTracker(set.hands);
    ({ hands, ran: handsRan } = set.handTracker.run(image, width, height, t, pose));
  }
  const t2 = performance.now();
  timings.pose = t1 - t0;
  timings.hands = t2 - t1;
  timings.total = t2 - t0;
  return { pipeline, t, width, height, pose, hands, handsRan, timings };
}

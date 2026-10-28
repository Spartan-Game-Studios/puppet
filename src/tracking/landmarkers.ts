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
import type { BodyMode, FaceResult, HandResult, HandStatus, Pipeline, PoseResult, TrackerResult } from './protocol';
import { roiFromLandmarks, roiFromPose, stabilizeRoi, type Roi } from './handRoi';
import { assignSides, dedupeKeep, isOtherHand, LabelTrust, sameHand, sideCost, type AssignContext, type HandCandidate } from './handAssign';

const SIDES = ['left', 'right'] as const;
const other = (s: Side): Side => (s === 'left' ? 'right' : 'left');

export interface LandmarkerSet {
  face?: FaceLandmarker;
  pose?: PoseLandmarker;
  /** One hand landmarker per (user) side, each fed a crop around that wrist. */
  hands?: Record<'left' | 'right', HandLandmarker>;
  /** Full-frame hand search (numHands 2), for hands the crops don't have. */
  handsFull?: HandLandmarker;
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
        [1, 1, 2].map((numHands) =>
          HandLandmarker.createFromOptions(fileset, {
            ...opts('hand_landmarker.task'),
            runningMode: 'VIDEO',
            numHands,
            minHandDetectionConfidence: 0.3,
            minHandPresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
          }),
        ),
      ).then(([l, r, full]) => {
        set.hands = { left: l, right: r };
        set.handsFull = full;
      }),
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
  status: HandStatus;
}

/** A hand found this recently is tracked from its own landmarks rather than re-found. */
const TRACK_MS = 250;
const CROP = 256;
/** A tracked hand changes side after fitting the other side better by this much (cost) for this many frames. */
const SWAP_MARGIN = 0.6;
const SWAP_FRAMES = 6;

export interface HandSearchOptions {
  /**
   * The full-frame search (a HandLandmarker with numHands 2 on the whole
   * image: MediaPipe's own palm detector, independent of the pose):
   * 'search' runs it for sides the crops didn't find, 'primary' every frame
   * before the crops (which then only look for what it missed), 'off' never.
   */
  full: 'off' | 'search' | 'primary';
  /** Run the full-frame search at most every n-th frame while a side is missing (1 = every frame). */
  fullEvery: number;
  /** ... and every n-th frame once every missing side has been gone for over a second (probably out of view). */
  fullIdleEvery: number;
}

export const DEFAULT_HAND_SEARCH: HandSearchOptions = { full: 'primary', fullEvery: 1, fullIdleEvery: 2 };

/**
 * Hand detection: one HandLandmarker per user side fed a square crop of that
 * hand, plus a full-frame search for hands the crops don't have.
 *
 * - Tracked (seen within TRACK_MS): the crop follows the hand's last
 *   landmarks and holds still while the hand stays inside it, so MediaPipe's
 *   own VIDEO-mode tracking stays valid in it.
 * - Not tracked: the full-frame search (numHands 2) runs first, and its hands
 *   are given to the missing sides by pose wrist, handedness, continuity and
 *   position (handAssign.ts). It needs no pose wrist, so hands the pose lost
 *   or misplaced (low in the frame, at the face, in front of the torso) are
 *   still found. A side it didn't fill is looked for at its pose wrist, if
 *   the pose has one.
 * - A hand found in a side's crop that is really the other hand (crossed arms,
 *   hands together) is dropped only when two cues agree (isOtherHand), and if
 *   both sides hold the same hand, the label, then the pose, decide who keeps it.
 */
export class HandCropTracker {
  readonly state: Record<Side, HandSideState> = {
    left: { last: null, lastT: -1e9, roi: null, misses: 0, status: 'skip' },
    right: { last: null, lastT: -1e9, roi: null, misses: 0, status: 'skip' },
  };
  opts: HandSearchOptions = { ...DEFAULT_HAND_SEARCH };
  /** How far the handedness label is right on this user's hands (learned). */
  readonly labelTrust = new LabelTrust();
  private canvas: OffscreenCanvas | null = null;
  private frame = 0;
  /** Frames in a row the found hands have fit the other sides clearly better. */
  disagree = 0;
  private fullT = -1;

  constructor(
    private readonly landmarkers: Record<Side, HandLandmarker>,
    private readonly fullFrame: HandLandmarker | null = null,
  ) {}

  run(image: ImageBitmap | HTMLVideoElement, width: number, height: number, t: number, pose: PoseResult | null): { hands: HandResult[]; ran: boolean } {
    this.frame++;
    const found: Partial<Record<Side, HandResult>> = {};
    const roiOf: Partial<Record<Side, Roi>> = {};
    const tracking: Record<Side, boolean> = { left: false, right: false };
    let ran = false;
    const pi = pose?.image;
    for (const side of SIDES) {
      const st = this.state[side];
      tracking[side] = st.last !== null && t - st.lastT < TRACK_MS;
    }
    const prev = (s: Side) => (tracking[s] ? this.state[s].last : null);
    const ctx: AssignContext = { pose: pi, width, height, prev: { left: prev('left'), right: prev('right') }, labelTrust: this.labelTrust.value };

    const missing = () => SIDES.filter((s) => !found[s]);
    const primary = this.opts.full === 'primary' && !!this.fullFrame;
    let fullRan = false;

    // 1. Tracked hands: crop from their own last landmarks (the other hand painted out).
    const trackCrops = () => {
      for (const side of missing()) {
        if (!tracking[side]) continue;
        const st = this.state[side];
        const roi = stabilizeRoi(st.roi, roiFromLandmarks(st.last!, width, height, 2.0));
        ran = true;
        const mask = found[other(side)]?.landmarks ?? prev(other(side));
        const h = this.detectIn(side, image, roi, width, height, t, mask);
        if (h && isOtherHand(h, side, ctx, mask)) {
          st.status = 'other-hand';
          continue;
        }
        if (h) {
          found[side] = h;
          roiOf[side] = roi;
          st.status = 'tracked';
        }
      }
    };

    // 2. Full-frame search for the sides still missing ('primary': every frame, first).
    const fullSearch = () => {
      const idle = missing().every((s) => this.state[s].misses > 30);
      const every = primary ? 1 : Math.max(1, idle ? this.opts.fullIdleEvery : this.opts.fullEvery);
      if (!this.fullFrame || this.opts.full === 'off' || !missing().length || this.frame % every !== 0) return;
      ran = true;
      fullRan = true;
      // VIDEO mode needs strictly increasing timestamps of its own.
      this.fullT = Math.max(this.fullT + 1, t);
      const cands = this.detectFull(image, this.fullT).filter(
        (c) => !SIDES.some((s) => found[s] && sameHand(c.landmarks, found[s]!.landmarks, width, height)),
      );
      const got = assignSides(cands, missing(), ctx);
      for (const side of SIDES) {
        const i = got[side];
        if (i === undefined) continue;
        found[side] = { ...cands[i], userSide: side };
        this.state[side].status = tracking[side] ? 'tracked' : 'found';
      }
    };
    if (primary) {
      fullSearch();
      trackCrops();
    } else {
      trackCrops();
      fullSearch();
    }

    // 3. Still missing: the crop at the pose wrist (a lost tracked hand gets one try there too).
    // Not looking there after the full-frame search looked everywhere is still a miss.
    const notHere = (side: Side): HandStatus => (tracking[side] || fullRan ? 'miss' : 'no-roi');
    for (const side of missing()) {
      const st = this.state[side];
      if (!pi) {
        st.status = notHere(side);
        continue;
      }
      const vis = pi[side === 'left' ? 15 : 16]?.visibility ?? 1;
      // Not tracked: once the hand has been gone a while, look at the pose
      // wrist only now and then when the full-frame search has just looked
      // everywhere (a crop still finds a small or partly hidden hand it
      // misses), or the wrist is probably out of view; this is most of the
      // hands worker's cost otherwise. A hand lost just now is looked for
      // every frame.
      const every = vis >= 0.5 && st.misses < 10 ? 1 : fullRan ? (vis < 0.5 ? 6 : 3) : vis < 0.5 ? 4 : 1;
      if (!tracking[side] && st.misses % every !== 0) {
        st.status = fullRan ? 'miss' : 'skip';
        continue;
      }
      // Alternate a normal and a wide crop between attempts.
      const roi = roiFromPose(pi, side, width, height, Math.floor(st.misses / every) % 2 === 0 ? 1 : 1.5);
      if (!roi) {
        st.status = notHere(side);
        continue;
      }
      ran = true;
      const mask = found[other(side)]?.landmarks ?? prev(other(side));
      const h = this.detectIn(side, image, roi, width, height, t + 0.5, mask);
      if (h && isOtherHand(h, side, ctx, mask)) {
        st.status = 'other-hand';
        continue;
      }
      if (h) {
        found[side] = h;
        roiOf[side] = roi;
        st.status = tracking[side] ? 'tracked' : 'found';
      } else {
        st.status = 'miss';
      }
    }

    // 4. One hand held by both sides: the side it fits better keeps it.
    if (found.left && found.right && sameHand(found.left.landmarks, found.right.landmarks, width, height)) {
      const keep = dedupeKeep(found.left, ctx, tracking);
      const drop = other(keep);
      delete found[drop];
      this.state[drop].status = 'duplicate';
    }

    // 5. Identity check: hands that have fit the other side clearly better
    // for a while (pose, trusted label, position; not continuity) change
    // side, e.g. after crossing, or a first assignment made on a bad cue.
    // Two hands are compared as a pair (swap or not); one hand on its own.
    const plain: AssignContext = { ...ctx, prev: {} };
    const c = (h: HandResult, s: Side) => sideCost(h, s, plain);
    const l = found.left;
    const r = found.right;
    const delta = l && r ? c(l, 'right') + c(r, 'left') - c(l, 'left') - c(r, 'right') : l ? c(l, 'right') - c(l, 'left') : r ? c(r, 'left') - c(r, 'right') : 0;
    this.disagree = delta < -SWAP_MARGIN ? this.disagree + 1 : 0;
    if (this.disagree >= SWAP_FRAMES) {
      this.disagree = 0;
      if (l) found.right = { ...l, userSide: 'right' };
      else delete found.right;
      if (r) found.left = { ...r, userSide: 'left' };
      else delete found.left;
      // The crops belonged to the other hands.
      for (const s of SIDES) delete roiOf[s];
    }

    for (const side of SIDES) {
      const st = this.state[side];
      const h = found[side];
      if (h) {
        h.userSide = side;
        this.labelTrust.observe(h, side, pi, width, height);
        st.last = h.landmarks;
        st.lastT = t;
        st.roi = roiOf[side] ?? null;
        st.misses = 0;
      } else {
        st.misses++;
        st.roi = null;
        if (st.status === 'other-hand' || st.status === 'duplicate' || t - st.lastT >= TRACK_MS) st.last = null;
      }
    }
    return { hands: SIDES.flatMap((s) => (found[s] ? [found[s]!] : [])), ran };
  }

  /** The full-frame search: up to two hands, any side (assigned by the caller). */
  private detectFull(image: ImageBitmap | HTMLVideoElement, t: number): Array<HandResult & HandCandidate> {
    const r: HandLandmarkerResult = this.fullFrame!.detectForVideo(image, t);
    return (r.landmarks ?? []).map((l, k) => {
      const h = r.handedness?.[k]?.[0];
      return {
        landmarks: l.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })),
        worldLandmarks: plain(r.worldLandmarks[k]),
        handedness: h?.categoryName ?? 'Unknown',
        score: h?.score ?? 0,
      };
    });
  }

  /**
   * Detect in a crop. `mask`: the other hand's landmarks, painted out of the
   * crop first, so a crop that also holds the other hand (hands together, both
   * at the face, a large crop from a desk camera) can't return it.
   */
  private detectIn(
    side: Side,
    image: ImageBitmap | HTMLVideoElement,
    roi: Roi,
    width: number,
    height: number,
    t: number,
    mask: Landmark[] | null = null,
  ): HandResult | null {
    this.canvas ??= new OffscreenCanvas(CROP, CROP);
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, CROP, CROP);
    g.drawImage(image, roi.x, roi.y, roi.size, roi.size, 0, 0, CROP, CROP);
    if (mask) paintOutHand(g, mask, roi, width, height, CROP);
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

/** Hand skeleton (MediaPipe hand landmark indices) used to paint a hand out of a crop. */
const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20], [5, 9], [9, 13], [13, 17]];

/** Paint a hand (normalized image landmarks) out of a crop of `roi`, `size` px square, in flat grey. */
export function paintOutHand(g: OffscreenCanvasRenderingContext2D, lms: Landmark[], roi: Roi, width: number, height: number, size: number): void {
  const k = size / roi.size;
  const px = (l: Landmark): [number, number] => [(l.x * width - roi.x) * k, (l.y * height - roi.y) * k];
  const handPx = Math.hypot((lms[9].x - lms[0].x) * width, (lms[9].y - lms[0].y) * height) * k;
  g.save();
  g.fillStyle = g.strokeStyle = '#808080';
  g.lineCap = g.lineJoin = 'round';
  g.lineWidth = Math.max(4, 0.45 * handPx);
  g.beginPath();
  for (const [a, b] of HAND_BONES) {
    g.moveTo(...px(lms[a]));
    g.lineTo(...px(lms[b]));
  }
  g.stroke();
  g.beginPath();
  for (const i of [0, 1, 5, 9, 13, 17]) g.lineTo(...px(lms[i]));
  g.closePath();
  g.fill();
  g.restore();
}

const handStatusOf = (set: LandmarkerSet): TrackerResult['handStatus'] =>
  set.handTracker ? { left: set.handTracker.state.left.status, right: set.handTracker.state.right.status } : undefined;

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
      set.handTracker ??= new HandCropTracker(set.hands, set.handsFull ?? null);
      ({ hands, ran: handsRan } = set.handTracker.run(image, width, height, t, poseHint));
    }
    timings.hands = timings.total = performance.now() - t0;
    return { pipeline, t, width, height, hands, handsRan, handStatus: handStatusOf(set), timings };
  }
  const pose = set.pose ? poseFrom(set.pose.detectForVideo(image, t)) : null;
  const t1 = performance.now();
  let hands: HandResult[] = [];
  let handsRan = false;
  // Main-thread fallback (one set does everything): hands right after the pose.
  if (mode === 'hands' && set.hands) {
    set.handTracker ??= new HandCropTracker(set.hands, set.handsFull ?? null);
    ({ hands, ran: handsRan } = set.handTracker.run(image, width, height, t, pose));
  }
  const t2 = performance.now();
  timings.pose = t1 - t0;
  timings.hands = t2 - t1;
  timings.total = t2 - t0;
  return { pipeline, t, width, height, pose, hands, handsRan, handStatus: handStatusOf(set), timings };
}

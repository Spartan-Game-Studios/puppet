/** Messages between the main thread and the tracking workers. */
import type { Landmark } from '../core/bodySolver';

export type BodyMode = 'face' | 'upper' | 'hands';

/**
 * Tracking runs as three pipelines so they overlap on the GPU instead of
 * queueing: 'face' (FaceLandmarker), 'body' (PoseLandmarker) and 'hands'
 * (two HandLandmarkers on crops; only in hands mode). Hands need the pose to
 * find a hand that isn't tracked yet, so they get the latest pose as a hint.
 */
export type Pipeline = 'face' | 'body' | 'hands';

export interface TrackerInit {
  type: 'init';
  pipeline: Pipeline;
  wasmBase: string;
  modelBase: string;
  delegate: 'GPU' | 'CPU';
  poseModel: 'lite' | 'full';
}

export interface TrackerFrame {
  type: 'frame';
  image: ImageBitmap;
  /** Milliseconds, monotonically increasing. */
  t: number;
  mode: BodyMode;
  /** Also return the 478 face landmarks (only needed for the preview overlay). */
  wantFaceLandmarks: boolean;
  /** 'hands' pipeline: the latest pose (image landmarks are what it uses). */
  pose?: PoseResult | null;
}

export interface FaceResult {
  /** ARKit-named blendshape scores (MediaPipe's `_neutral` is dropped). */
  blendshapes: Record<string, number>;
  /** Facial transformation matrix, column-major 4x4 (canonical face -> camera, cm). */
  matrix: number[] | null;
  /** Normalized image landmarks, flattened x,y pairs (optional, for the overlay). */
  landmarks2d?: Float32Array;
}

export interface PoseResult {
  world: Landmark[];
  image: Landmark[];
}

export interface HandResult {
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
  handedness: string;
  score: number;
  /** The user's anatomical side, when known (hands found from a pose-wrist crop). */
  userSide?: 'left' | 'right';
}

/**
 * What the hand search did for one user side on a frame (debug readout):
 * skip = not looked for (weak pose wrist, looked only now and then),
 * no-roi = nowhere to look (no usable pose wrist), miss = looked (the
 * full-frame search counts as looking everywhere), found nothing,
 * other-hand = found a hand that belonged to the other side, duplicate = the
 * other side's crop found the same hand, tracked = found again from its own
 * last landmarks, found = (re)found from a search.
 */
export type HandStatus = 'skip' | 'no-roi' | 'miss' | 'other-hand' | 'duplicate' | 'tracked' | 'found';

export interface TrackerResult {
  type: 'result';
  pipeline: Pipeline;
  t: number;
  width: number;
  height: number;
  /** Present on 'face' results (null = no face found). */
  face?: FaceResult | null;
  /** Present on 'body' results. */
  pose?: PoseResult | null;
  hands?: HandResult[];
  /** Whether the hand model ran this frame (it is skipped when no wrist is in view). */
  handsRan?: boolean;
  /** Per user side: what the hand search did this frame. */
  handStatus?: Record<'left' | 'right', HandStatus>;
  timings: { face: number; pose: number; hands: number; total: number };
  /** Source video time of the frame (seconds), filled in on the main thread. */
  videoTime?: number;
  /**
   * A 'body' result sent again with newer hands: same pose (already applied),
   * fresher hand landmarks. Filled in on the main thread.
   */
  handsUpdate?: boolean;
}

export interface TrackerReady {
  type: 'ready';
  delegate: 'GPU' | 'CPU';
}

export interface TrackerError {
  type: 'error';
  message: string;
  fatal: boolean;
}

/** Switch the body pipeline's pose model without restarting. */
export interface TrackerSetPoseModel {
  type: 'setPoseModel';
  poseModel: 'lite' | 'full';
}

export type ToWorker = TrackerInit | TrackerFrame | TrackerSetPoseModel;
export type FromWorker = TrackerResult | TrackerReady | TrackerError;

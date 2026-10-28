/** Messages between the main thread and the tracking workers. */
import type { Landmark } from '../core/bodySolver';

export type BodyMode = 'face' | 'upper' | 'hands';

/**
 * Tracking runs as two pipelines so they overlap on the GPU instead of queueing:
 * 'face' (FaceLandmarker) and 'body' (PoseLandmarker, then HandLandmarker).
 */
export type Pipeline = 'face' | 'body';

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
  timings: { face: number; pose: number; hands: number; total: number };
  /** Source video time of the frame (seconds), filled in on the main thread. */
  videoTime?: number;
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

export type ToWorker = TrackerInit | TrackerFrame;
export type FromWorker = TrackerResult | TrackerReady | TrackerError;

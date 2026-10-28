/// <reference lib="webworker" />
/**
 * Tracking worker: runs one MediaPipe pipeline ('face' or 'body') off the main
 * thread so the 60 fps render loop never waits on inference. Frames arrive as
 * transferred ImageBitmaps; one is processed at a time (the main thread waits
 * for the result before sending the next, so frames never queue up).
 */
import { createLandmarkers, detect, type LandmarkerSet } from './landmarkers';
import type { FromWorker, Pipeline, ToWorker } from './protocol';

let set: LandmarkerSet | null = null;
let pipeline: Pipeline = 'face';
const post = (m: FromWorker, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    pipeline = msg.pipeline;
    try {
      try {
        set = await createLandmarkers([pipeline], msg.wasmBase, msg.modelBase, msg.delegate, msg.poseModel);
      } catch (e) {
        if (msg.delegate !== 'GPU') throw e;
        // No WebGL2 in workers here (or GPU init failed): fall back to CPU.
        set = await createLandmarkers([pipeline], msg.wasmBase, msg.modelBase, 'CPU', msg.poseModel);
      }
      post({ type: 'ready', delegate: set.delegate });
    } catch (e) {
      post({ type: 'error', message: String((e as Error)?.message ?? e), fatal: true });
    }
    return;
  }
  if (msg.type === 'frame') {
    if (!set) {
      msg.image.close();
      return;
    }
    try {
      const r = detect(set, pipeline, msg.image, msg.t, msg.mode, msg.wantFaceLandmarks);
      const transfer: Transferable[] = [];
      if (r.face?.landmarks2d) transfer.push(r.face.landmarks2d.buffer);
      post({ type: 'result', ...r }, transfer);
    } catch (e) {
      post({ type: 'error', message: String((e as Error)?.message ?? e), fatal: false });
    } finally {
      msg.image.close();
    }
  }
};

/**
 * Runs the body pipeline (pose + hands, landmarkers.ts) over a numbered PNG
 * sequence on the main thread, frame by frame, with VIDEO-mode timestamps.
 * A fast, deterministic way to measure hand detection without playing video.
 * Driven by scripts/track-seq.mjs: window.__seq.run(from, to, step).
 */
import { createLandmarkers, detect } from '../src/tracking/landmarkers';
import { roiFromPose } from '../src/tracking/handRoi';

async function main() {
  const p = new URLSearchParams(location.search);
  const poseModel = (p.get('pose') as 'lite' | 'full') ?? 'lite';
  const set = await createLandmarkers(['body', 'hands'], '/mediapipe/wasm', '/mediapipe/models', 'GPU', poseModel);
  let dbgT = 1e7;
  (window as unknown as { __seq: unknown }).__seq = {
    async run(from: number, to: number, step = 1) {
      const out = [];
      for (let i = from; i < to; i += step) {
        const img = new Image();
        img.src = `/__local/frames/${String(i).padStart(4, '0')}.png`;
        await img.decode();
        const bmp = await createImageBitmap(img);
        const t = Math.round((i * 1000) / 30) + 1;
        const r = detect(set, 'body', bmp, t, 'hands', false);
        bmp.close();
        out.push({
          i,
          pose: !!r.pose,
          hands: (r.hands ?? []).map((h) => ({ side: h.userSide, label: h.handedness, score: h.score, wrist: [h.landmarks[0].x, h.landmarks[0].y], world: h.worldLandmarks.map((l) => [l.x, l.y, l.z]) })),
          handsRan: r.handsRan,
          status: set.handTracker ? [set.handTracker.state.left.status, set.handTracker.state.right.status] : null,
          ms: r.timings,
        });
      }
      return out;
    },
    /** Frame i with the pose's image landmarks drawn on it (debug). */
    async drawPose(i: number) {
      const img = new Image();
      img.src = `/__local/frames/${String(i).padStart(4, '0')}.png`;
      await img.decode();
      const pose = set.pose!.detectForVideo(img, (dbgT += 1000));
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const l = pose.landmarks[0];
      g.strokeStyle = '#ff3b00';
      g.lineWidth = 2;
      for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24]]) {
        g.beginPath();
        g.moveTo(l[a].x * c.width, l[a].y * c.height);
        g.lineTo(l[b].x * c.width, l[b].y * c.height);
        g.stroke();
      }
      return { url: c.toDataURL(), lm: l.slice(11, 17).map((p) => [p.x, p.y, p.visibility]), world: pose.worldLandmarks[0].slice(11, 17).map((p) => [p.x, p.y, p.z]), all: { image: l, world: pose.worldLandmarks[0] } };
    },
    /** The crop the hand model would see for frame i (debug). */
    async crop(i: number, side: 'left' | 'right') {
      const img = new Image();
      img.src = `/__local/frames/${String(i).padStart(4, '0')}.png`;
      await img.decode();
      const pose = set.pose!.detectForVideo(img, (dbgT += 1000));
      const pr = { image: pose.landmarks[0] };
      const roi = roiFromPose(pr.image, side, img.width, img.height);
      if (!roi) return null;
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d')!.drawImage(img, roi.x, roi.y, roi.size, roi.size, 0, 0, 256, 256);
      return { roi, url: c.toDataURL() };
    },
  };
  document.title = 'ready';
}
main().catch((e) => {
  document.title = 'error';
  console.error(e);
});

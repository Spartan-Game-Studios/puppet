/** Tracking preview: the camera image with landmarks drawn over it. */
import type { TrackerResult } from './protocol';

const POSE_EDGES: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [15, 17], [15, 19], [17, 19], [16, 18], [16, 20], [18, 20],
];
const HAND_EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

export function drawPreview(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  r: TrackerResult | null,
  mirror: boolean,
  accent: string,
): void {
  const { width: W, height: H } = ctx.canvas;
  ctx.save();
  if (mirror) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  if (video.readyState >= 2) ctx.drawImage(video, 0, 0, W, H);
  else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
  }
  if (r) {
    if (r.face?.landmarks2d) {
      ctx.fillStyle = '#ffffff';
      const a = r.face.landmarks2d;
      for (let i = 0; i < a.length; i += 2) ctx.fillRect(a[i] * W - 0.5, a[i + 1] * H - 0.5, 1.5, 1.5);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;
    if (r.pose) {
      const p = r.pose.image;
      ctx.beginPath();
      for (const [a, b] of POSE_EDGES) {
        if ((p[a].visibility ?? 1) < 0.5 || (p[b].visibility ?? 1) < 0.5) continue;
        ctx.moveTo(p[a].x * W, p[a].y * H);
        ctx.lineTo(p[b].x * W, p[b].y * H);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = '#ffffff';
    for (const h of r.hands ?? []) {
      const p = h.landmarks;
      ctx.beginPath();
      for (const [a, b] of HAND_EDGES) {
        ctx.moveTo(p[a].x * W, p[a].y * H);
        ctx.lineTo(p[b].x * W, p[b].y * H);
      }
      ctx.stroke();
      for (const q of p) ctx.fillRect(q.x * W - 2, q.y * H - 2, 4, 4);
    }
  }
  ctx.restore();
}

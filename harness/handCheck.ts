/** Run the hand and pose models once on a still image (?img=url). Debug aid. */
import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

async function main() {
  const p = new URLSearchParams(location.search);
  const img = new Image();
  img.src = p.get('img') ?? '/__local/frame.png';
  await img.decode();
  const fs = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
  const delegate = (p.get('delegate') as 'GPU' | 'CPU') ?? 'GPU';
  const [hand, pose] = await Promise.all([
    HandLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: '/mediapipe/models/hand_landmarker.task', delegate },
      runningMode: 'IMAGE',
      numHands: 2,
      minHandDetectionConfidence: Number(p.get('conf') ?? 0.5),
    }),
    PoseLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: '/mediapipe/models/pose_landmarker_lite.task', delegate },
      runningMode: 'IMAGE',
    }),
  ]);
  const h = hand.detect(img);
  const ps = pose.detect(img);
  (window as unknown as { __hands: unknown }).__hands = {
    hands: h.handedness.map((x, i) => ({ label: x[0].categoryName, score: x[0].score, wrist: h.landmarks[i][0] })),
    wrists: ps.landmarks[0] ? [ps.landmarks[0][15], ps.landmarks[0][16]] : null,
  };
}
main().catch((e) => ((window as unknown as { __hands: unknown }).__hands = { error: String(e) }));

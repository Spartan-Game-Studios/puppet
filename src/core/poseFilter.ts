/**
 * One-euro smoothing of a pose's world and image landmarks before the body
 * solver. The solver rebuilds arm depth from the 2D image points, so those
 * are smoothed too.
 */
import type { Landmark } from './bodySolver';
import { OneEuroVector, type OneEuroParams } from './oneEuro';

export interface PoseLandmarks {
  world: Landmark[];
  image: Landmark[];
}

export class PoseFilter {
  private world = new OneEuroVector(33 * 3);
  private image = new OneEuroVector(33 * 2);
  /** The last filtered pose. */
  last: PoseLandmarks | null = null;

  setParams(p: OneEuroParams): void {
    this.world.setParams(p);
    this.image.setParams(p);
  }

  filter(pose: PoseLandmarks, t: number): PoseLandmarks {
    const f = this.world.filter(pose.world.flatMap((l) => [l.x, l.y, l.z]), t);
    const fi = this.image.filter(pose.image.flatMap((l) => [l.x, l.y]), t);
    this.last = {
      world: pose.world.map((l, i) => ({ x: f[3 * i], y: f[3 * i + 1], z: f[3 * i + 2], visibility: l.visibility })),
      image: pose.image.map((l, i) => ({ x: fi[2 * i], y: fi[2 * i + 1], z: l.z, visibility: l.visibility })),
    };
    return this.last;
  }
}

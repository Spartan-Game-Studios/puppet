import { describe, expect, it } from 'vitest';
import { DEFAULT_DRIVE, limbFollowRateFor } from '../src/scene/avatar';

describe('limb follow rate', () => {
  it('is the default at the default smoothing, the torso rate at full smoothing', () => {
    expect(limbFollowRateFor(0.5)).toBe(DEFAULT_DRIVE.limbFollowRate);
    expect(limbFollowRateFor(1)).toBe(DEFAULT_DRIVE.followRate);
  });

  it('falls as smoothing rises, and clamps outside 0..1', () => {
    expect(limbFollowRateFor(0)).toBeGreaterThan(limbFollowRateFor(0.5));
    expect(limbFollowRateFor(-1)).toBe(limbFollowRateFor(0));
    expect(limbFollowRateFor(2)).toBe(limbFollowRateFor(1));
  });
});

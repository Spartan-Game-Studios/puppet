/**
 * Hand-gesture triggers for hotkeys: an adapter interface, so a gesture
 * recogniser plugs in without the hotkey code knowing where it lives.
 * `trackerGestureSource` adapts the tracker's GestureTracker
 * (src/core/gestures.ts): each change of a hand's gesture ends the old one
 * and starts the new one. Hands are the user's own (not the mirrored avatar's).
 */
import type { Gesture, GestureEvent as TrackerGestureEvent } from '../core/gestures';
import type { GestureName } from './bindings';

export interface GestureEvent {
  gesture: GestureName;
  hand: 'left' | 'right';
  state: 'start' | 'end';
  confidence?: number;
}

export interface GestureSource {
  /** Returns an unsubscribe function. */
  subscribe(cb: (e: GestureEvent) => void): () => void;
}

/** A source driven by hand (tests, the harness, a future recogniser). */
export class ManualGestureSource implements GestureSource {
  private subs = new Set<(e: GestureEvent) => void>();
  subscribe(cb: (e: GestureEvent) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(e: GestureEvent): void {
    for (const s of this.subs) s(e);
  }
}

/** Tracker gesture names -> binding names. */
export const GESTURE_NAMES: Record<Exclude<Gesture, 'none'>, GestureName> = {
  fist: 'fist',
  open: 'open_palm',
  point: 'point',
  peace: 'peace',
  thumbsUp: 'thumbs_up',
  ok: 'ok',
  rock: 'horns',
};

/** Anything with GestureTracker's `on(listener) -> unsubscribe`. */
export interface TrackerGestures {
  on(listener: (e: TrackerGestureEvent) => void): () => void;
}

/** The tracker's gestures as a GestureSource, or null if there is no gesture tracker. */
export function trackerGestureSource(tracker: TrackerGestures | null | undefined): GestureSource | null {
  if (!tracker || typeof tracker.on !== 'function') return null;
  return {
    subscribe: (cb) =>
      tracker.on((e) => {
        if (e.previous !== 'none') cb({ gesture: GESTURE_NAMES[e.previous], hand: e.hand, state: 'end' });
        if (e.gesture !== 'none') cb({ gesture: GESTURE_NAMES[e.gesture], hand: e.hand, state: 'start', confidence: e.confidence });
      }),
  };
}

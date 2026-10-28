/**
 * Hand-gesture triggers for hotkeys: an adapter interface, so a gesture
 * recogniser plugs in without the hotkey code knowing where it lives.
 *
 * TODO(tracking-quality): the tracking-quality branch adds gesture events to
 * the tracker (fist, open palm, point, peace, thumbs up, OK, horns). When it
 * lands, implement `trackerGestureSource` below by subscribing to them and
 * mapping each to a GestureEvent ('start' when a gesture is recognised,
 * 'end' when it stops), then pass it to HotkeyManager.attachGestures() in
 * main.ts. Bindings with gesture triggers already resolve (see bindings.ts,
 * tests/bindings.test.ts); the HOTKEYS panel lists them as waiting for a
 * source until one is attached.
 */
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

/**
 * The tracker's gestures as a GestureSource, or null while the tracker has
 * none. TODO(tracking-quality): see the file comment.
 */
export function trackerGestureSource(tracker: unknown): GestureSource | null {
  const t = tracker as { onGesture?: unknown } | null;
  if (!t || typeof t.onGesture !== 'function') return null;
  // Expected shape once tracking-quality merges: tracker.onGesture(cb) -> unsubscribe,
  // cb({ gesture, hand, state, confidence }). Adjust here if it differs.
  const on = t.onGesture as (cb: (e: GestureEvent) => void) => () => void;
  return { subscribe: (cb) => on.call(tracker, cb) };
}

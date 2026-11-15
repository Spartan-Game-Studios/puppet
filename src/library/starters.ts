/**
 * Starter avatars: a few CC0 (public domain) VRMs bundled in public/starters/
 * (licences and sources in public/starters/LICENSES.md), so a first launch
 * has something to put on stage before the user brings their own model.
 *
 * They go through the normal import (hash, check, thumbnail), so they are
 * ordinary library entries: renamable, deletable, and never added again
 * once the index says `starters: 'done'`.
 */
import type { Library } from './library';

/** Kept in step with public/starters/LICENSES.md. The last one added shows first (Two-Tails). */
export const STARTERS: readonly string[] = ['witch.vrm', 'chubby-tubby-cat.vrm', 'strawberry-princess.vrm', 'two-tails.vrm'];

/** Import the starters (one at a time, quietly). Failures are only logged. */
export async function addStarters(library: Library): Promise<void> {
  for (const file of STARTERS) {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}starters/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await library.import({ name: file, bytes: await res.arrayBuffer() });
      if (r.status === 'error') throw new Error(r.error);
    } catch (e) {
      console.warn(`[library] starter ${file}:`, e);
    }
  }
}

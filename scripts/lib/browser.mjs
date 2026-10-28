// Shared Playwright setup for the headless test scripts. Uses the installed
// Google Chrome (channel 'chrome') so no browser download is needed.
// Local, non-repo assets (a personal VRM, rendered footage) are served through
// request interception, so they never have to be copied into the repo.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

export const BASE = process.env.PUPPET_URL ?? 'http://localhost:5173';

export async function launch({ headless = true, extraArgs = [] } = {}) {
  return chromium.launch({
    channel: process.env.PUPPET_CHROME_CHANNEL ?? 'chrome',
    headless,
    args: [
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...extraArgs,
    ],
  });
}

/** Serve local files at fake same-origin paths, e.g. { '/__local/model.vrm': '/abs/path.vrm' }. */
export async function serveLocal(page, map) {
  const cache = new Map();
  for (const [urlPath, file] of Object.entries(map)) {
    await page.route(`**${urlPath}`, async (route) => {
      if (!cache.has(file)) cache.set(file, await readFile(file));
      const body = cache.get(file);
      const type = file.endsWith('.webm') ? 'video/webm' : file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      // Byte ranges, so <video> can seek.
      const range = route.request().headers()['range'];
      const m = range && /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
        await route.fulfill({
          status: 206,
          body: body.subarray(start, end + 1),
          headers: {
            'content-type': type,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${body.length}`,
          },
        });
        return;
      }
      await route.fulfill({ status: 200, body, headers: { 'content-type': type, 'accept-ranges': 'bytes' } });
    });
  }
}

export function requireEnv(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Set ${name}.`);
    process.exit(2);
  }
  return v;
}

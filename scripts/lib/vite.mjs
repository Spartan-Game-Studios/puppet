// Start a private Vite dev server for a test script (its own port, so it never
// collides with `pnpm dev` on 5173 or other test runs).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function startVite(port) {
  if (process.env.PUPPET_URL) return { url: process.env.PUPPET_URL, close() {} };
  const bin = fileURLToPath(new URL('../../node_modules/.bin/vite', import.meta.url));
  const child = spawn(bin, ['--port', String(port), '--strictPort', '--clearScreen', 'false'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`vite did not start:\n${log}`)), 30000);
    const on = (d) => {
      log += d;
      if (/Local:|ready in/i.test(log)) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (c) => reject(new Error(`vite exited ${c}:\n${log}`)));
  });
  return { url: `http://localhost:${port}`, close: () => child.kill() };
}

// Fetch the CC0 test avatars for the compatibility sweep (scripts/compat-sweep.mjs)
// into test-assets/cc0/. Two of them (devil.vrm, the-worm.vrm) are committed;
// the rest are downloaded here and checked against pinned SHA-256 hashes.
//
//   node scripts/fetch-test-avatars.mjs [--only=a.vrm,b.vrm]
//
// All from the Open Source Avatars registry (opensourceavatars.com, by ToxSam).
// Each is CC0 in the registry AND in the licence written into the file's own
// VRM meta. See test-assets/cc0/LICENSES.md. Downloads are parsed by three-vrm
// only (never executed); a hash mismatch deletes the file and fails.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../test-assets/cc0/', import.meta.url));

/** name, author, collection, url, sha256, bytes. Kept in step with test-assets/cc0/LICENSES.md. */
export const AVATARS = [
  { file: 'devil.vrm', name: 'Devil', author: 'Polygonal Mind', collection: '100Avatars R1', url: 'https://arweave.net/gfVzs1oH_aPaHVxpQK86HT_rqzyrFPOUKUrDJ30yprs', sha256: '2e428dd1846504a77f3936259f489a899cc92aa6179b769a1aee230f875a9b4d', committed: true },
  { file: 'the-worm.vrm', name: 'The Worm', author: 'ToxSam', collection: 'ToxSam', url: 'https://gateway.pinata.cloud/ipfs/QmVLhUz4mtr2RH5t5UKrig6s8MWRXy68MzTvfJvdkMefMt/TheWorm.vrm', sha256: 'e6c9fe666e7e5695af9542ecdc8eab4b85cb5ff0ba708bdc950dcf1fbc8b9fdf', committed: true },
  { file: 'two-tails.vrm', name: 'Two-Tails', author: 'Polygonal Mind', collection: '100Avatars R3', url: 'https://arweave.net/JE2Ix9bF-9x6r4ovLKsgMoNf6QJQf_NbmTLSq9Hp_OM', sha256: '3cc9b73c1bf166ebcdaaa9e7922d92af147b0c90ab8fc1419c9b56c07ee4e87a' },
  { file: 'witch.vrm', name: 'Witch', author: 'Polygonal Mind', collection: '100Avatars R1', url: 'https://arweave.net/0YLwWzDkvVWn9ttv2RAdc8bvWcCBjvYPpu7fpjpHYU0', sha256: '33fa9a9c4c10d0ba0ab22a051809afddb9b53e7f51cbb69df91e1bf9e1653652' },
  { file: 'jenny.vrm', name: 'Jenny', author: 'Polygonal Mind', collection: '100Avatars R3', url: 'https://arweave.net/kgTirc4OvUWbJhIKC2CB3_pYsYuB62KTj90IdE8s3sk', sha256: '9f287e57a973b245365d7252bc6852c6c29904f8bb09e291f58cbee9a3f1298c' },
  { file: 'lady-koi.vrm', name: 'LadyKoi', author: 'Polygonal Mind', collection: '100Avatars R3', url: 'https://arweave.net/t3aTp6AhxfdLcq5I3HZx29wK8MFQGmDC9wPwXrHQoW0', sha256: 'a20e3db072640b96f7d9089c1f7efd9962ce603d4a6f42d1cebe74c0e84fc9e7' },
  { file: 'strawberry-princess.vrm', name: 'StrawberryPrincess', author: 'Polygonal Mind', collection: '100Avatars R3', url: 'https://arweave.net/0Wwhn0-G8wESHYX2lD9FRPWw6smAHN_wsH6hNPrz9eE', sha256: '5d68db0ff969a158fa9c76f0cef523010051fa3be9565bf6e101989aa0fc5a83' },
  { file: 'aurora.vrm', name: 'Aurora', author: 'Polygonal Mind / ToxSam', collection: 'ToxSam', url: 'https://gateway.pinata.cloud/ipfs/QmVvfCcAKYozNQwwxPbHyNohLyBJbTrCBSM1Ycck3ouJSj/Avartar_Aurora.vrm', sha256: '9c205fb2b3188b6b37a7e089ee45a32f5602684929076fa71253fcd61f11151d' },
  { file: 'chubby-tubby-cat.vrm', name: 'Chubby Tubby Cat', author: 'ToxSam', collection: 'ToxSam', url: 'https://gateway.pinata.cloud/ipfs/QmY4NQRArQaEWPgyzyTuCSvyAnBUhtsshFKPjJHbbzVKLL/ChubbyTubbyCat.vrm', sha256: 'f1e31eb45d28620862759e6803c42c46c61e32fdab47fcb5230ddbbb273add52' },
  { file: 'frosty-boogie.vrm', name: 'FrostyBoogie', author: 'ToxSam', collection: 'ToxSam', url: 'https://gateway.pinata.cloud/ipfs/QmbNqsuVYaVrYtC6ALeco3jogcSi4NbbzfrGJs5i7fjB26/FrostyBoogie.vrm', sha256: '94e51ec28841cdc4a584c1c961d2fae368fcd25e75564ad9460625004a498202' },
  { file: 'crustybutt-da-king.vrm', name: 'Crustybutt da king', author: 'ToxSam', collection: 'ToxSam', url: 'https://gateway.pinata.cloud/ipfs/QmZan3z9nMTmEKSf99bPb8crKcYm4scMJd5YpCTN14B9mn/Crustybutt_da_gobblin_king.vrm', sha256: 'a3577f0838cbaf99484b0ebab129d264429bffe4ba9c4e8a5ffae5155dc86069' },
  { file: 'gary-grifter.vrm', name: 'GARY GRIFTER 1.0', author: 'NeonGlitch86', collection: 'NeonGlitch86 Collection', url: 'https://raw.githubusercontent.com/neonglitch86/vrm/main/GG_1.vrm', sha256: 'fc84fc35ad78f8010f688ed2ae9a12045a9ae814429e70bd51f9fe0e4e2b6ea7' },
  { file: 'grifter-squaddie-1.vrm', name: 'Grifter Squaddie #1', author: 'ToxSam', collection: 'Grifters Squaddies', url: 'https://gateway.pinata.cloud/ipfs/QmVDNBLZ9fby8mT23SHHEq3oNsS5KD9rf9BZFZwSc4CsXF/default_1.vrm', sha256: 'abf1ac65acbb6be50fe37be95bb882d0a8d57c495724ded12a452baed9d46941' },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
  await mkdir(DIR, { recursive: true });
  let failed = 0;
  for (const a of AVATARS) {
    if (only.length && !only.includes(a.file)) continue;
    const path = join(DIR, a.file);
    if (existsSync(path) && sha(await readFile(path)) === a.sha256) {
      console.log(`[avatars] ${a.file}: ok`);
      continue;
    }
    try {
      const res = await fetch(a.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const h = sha(buf);
      if (h !== a.sha256) throw new Error(`hash mismatch (${h})`);
      await writeFile(path, buf);
      console.log(`[avatars] ${a.file}: downloaded ${(buf.length / 1e6).toFixed(1)} MB`);
    } catch (e) {
      failed++;
      await rm(path, { force: true });
      console.error(`[avatars] ${a.file}: FAILED ${e.message} (${a.url})`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

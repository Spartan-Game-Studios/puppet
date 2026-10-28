# CC0 test avatars

Fixtures for the VRM compatibility sweep (`scripts/compat-sweep.mjs`). All are
from the [Open Source Avatars](https://opensourceavatars.com) registry (by
ToxSam). Each was checked to be CC0 (public domain) **both** in the registry
listing **and** in the licence written into the file's own VRM meta
(`licenseName: CC0`). Files are unmodified.

Committed (small):

| File | Name | Author | Collection | Licence | Source | SHA-256 |
|---|---|---|---|---|---|---|
| devil.vrm | Devil | Polygonal Mind | 100Avatars R1 | CC0 | https://arweave.net/gfVzs1oH_aPaHVxpQK86HT_rqzyrFPOUKUrDJ30yprs | `2e428dd1846504a77f3936259f489a899cc92aa6179b769a1aee230f875a9b4d` |
| the-worm.vrm | The Worm | ToxSam | ToxSam | CC0 | https://gateway.pinata.cloud/ipfs/QmVLhUz4mtr2RH5t5UKrig6s8MWRXy68MzTvfJvdkMefMt/TheWorm.vrm | `e6c9fe666e7e5695af9542ecdc8eab4b85cb5ff0ba708bdc950dcf1fbc8b9fdf` |

Fetched by `node scripts/fetch-test-avatars.mjs` (pinned URL + SHA-256 in that
script; all CC0, same check): Two-Tails, Witch, Jenny, LadyKoi,
StrawberryPrincess (Polygonal Mind, 100Avatars), Aurora, Chubby Tubby Cat,
FrostyBoogie, Crustybutt da king, Grifter Squaddie #1 (ToxSam), GARY GRIFTER
1.0 (NeonGlitch86).

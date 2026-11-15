# Starter avatars (CC0)

VPuppet adds these to an empty library on first launch (`src/library/starters.ts`),
so there is something to put on stage before you bring your own VRM. They are
ordinary library entries: rename or delete them like any other model.

All are from the [Open Source Avatars](https://opensourceavatars.com) registry
(by ToxSam). Each was checked to be CC0 1.0 (public domain) **both** in the
registry listing **and** in the licence written into the file's own VRM meta
(`licenseName: CC0`, commercial use allowed). Files are unmodified; the hashes
match the pins in `scripts/fetch-test-avatars.mjs`.

| File | Name | Author | Collection | Licence | Source | SHA-256 |
|---|---|---|---|---|---|---|
| two-tails.vrm | Two-Tails | Polygonal Mind | 100Avatars R3 | CC0 | https://arweave.net/JE2Ix9bF-9x6r4ovLKsgMoNf6QJQf_NbmTLSq9Hp_OM | `3cc9b73c1bf166ebcdaaa9e7922d92af147b0c90ab8fc1419c9b56c07ee4e87a` |
| strawberry-princess.vrm | Strawberry Princess | Polygonal Mind | 100Avatars R3 | CC0 | https://arweave.net/0Wwhn0-G8wESHYX2lD9FRPWw6smAHN_wsH6hNPrz9eE | `5d68db0ff969a158fa9c76f0cef523010051fa3be9565bf6e101989aa0fc5a83` |
| chubby-tubby-cat.vrm | Chubby Tubby Cat | ToxSam | ToxSam | CC0 | https://gateway.pinata.cloud/ipfs/QmY4NQRArQaEWPgyzyTuCSvyAnBUhtsshFKPjJHbbzVKLL/ChubbyTubbyCat.vrm | `f1e31eb45d28620862759e6803c42c46c61e32fdab47fcb5230ddbbb273add52` |
| witch.vrm | Witch | Polygonal Mind | 100Avatars R1 | CC0 | https://arweave.net/0YLwWzDkvVWn9ttv2RAdc8bvWcCBjvYPpu7fpjpHYU0 | `33fa9a9c4c10d0ba0ab22a051809afddb9b53e7f51cbb69df91e1bf9e1653652` |

Only CC0 models belong here. Check both the registry and the file's own meta
before adding one, and add its row here and its name to `STARTERS`.

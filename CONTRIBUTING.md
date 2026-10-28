# Contributing

Thanks for helping. Short rules:

- **Licence hygiene first.** Puppet is MIT. Only add dependencies under permissive licences (MIT, Apache-2.0, BSD, ISC, zlib; OFL for fonts) and list them in `THIRD_PARTY_NOTICES.md`. Do not copy, port or "read and reimplement" code from other VTuber apps, especially non-commercial / share-alike ones (for example XR Animator, CC BY-NC-SA). Work from the libraries' own docs and papers.
- **No avatars or footage in git.** `*.vrm` is ignored; keep it that way. Test footage rendered from a model carries that model's licence.
- Before a PR: `pnpm typecheck && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml`. If you touch physics, run `scripts/physics-test.mjs` against a spring-heavy model and include the before/after table.
- Keep pure logic (mapping, filters, solvers, encoders) free of DOM/three.js side effects so it stays unit-testable, and add tests with it.
- UI: brutalist rules (monospace, black/white plus the one accent `#ff3b00`, 3 px rules, no radius, no shadows, no gradients, ALL-CAPS labels, shortcuts shown inline). Static layout lives in `index.html`; only repeated rows are built in script.
- Commit by path (no `git add -A`), one logical change per commit.

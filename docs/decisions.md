# Decision log

The owner's decisions are in `prompts/PLAN.md` §1 (kept out of the repository) and are not
repeated here. This file records the decisions taken while building, and why.

## Phase 0 (2026-11-14)

- **Upstream pin.** The owner asked for the submodule to go straight to `v0.7.0` rather than
  `v0.6.1`, because only 0.7.0 has display driver contract 1, `runtime/program/`,
  `runtime/web/program.html` and the shell example. The tag does not exist yet: the submodule
  points to the commit `a45a85f` ("Release 0.7.0"), and moves to the tag as soon as it is pushed
  upstream. The About box shows "untagged" until then.
- **`prompts/` stays out of the repository**, at the owner's request. It is in `.gitignore`.
- **TypeScript 6.0.3, not 7.** typescript-eslint 8.72 accepts TypeScript below 6.1.
- **Lit without decorators.** Components use `static properties` and plain fields, so the build
  does not depend on how Vite's transpiler handles decorators.
- **One base path everywhere.** Dev, preview and the Pages build all serve the site under
  `/lvgl-mpy-studio-web/`, so a wrong path shows up locally and not only once deployed.
- **Release age enforced by pnpm.** `pnpm-workspace.yaml` sets `minimumReleaseAge` to two weeks,
  so the rule of §3.1 also holds for transitive packages. Direct dependencies are pinned
  exactly.
- **The upstream release is read at build time** by `scripts/upstream-info.mjs`: the version from
  `lvgl_mpy_studio/__init__.py`, the tag from `git describe --exact-match`. CI fetches the
  submodule's tags for this.

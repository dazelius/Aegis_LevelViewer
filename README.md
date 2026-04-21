# Aegisgram

Web-based Unity scene viewer + social feedback layer for Project Aegis.
Walk levels in a third-person shooter perspective and anchor feedback
messages (with a screenshot and world position) to the exact spot you
were looking at.

## Architecture

- **server/** - Node.js + Express + TypeScript backend
  - Two runtime modes (auto-detected at startup):
    - **live** (local dev) — Sparse-clones Project Aegis via GitLab,
      parses `.unity` YAML, streams textures/meshes from the clone.
    - **bundle** (deployed) — Reads a pre-baked content pack under
      `data/bundle/` and serves scenes/blobs with zero upstream I/O.
      Activates automatically whenever `data/bundle/manifest.json`
      exists.
  - Serves the built web client on the same port as the API.
- **web/** - React + Vite + react-three-fiber frontend
  - Lists available scenes, renders a selected scene with Three.js,
    overlays feedback pins, supports multiplayer presence.

## Prerequisites

### Local development (live mode)

- Node.js 18+
- Git CLI on PATH
- Git LFS (`git lfs install`) — Project Aegis stores FBX/texture bytes
  via LFS; without it the viewer renders grey placeholders.
- Unity Editor matching the Aegis project version (optional but
  recommended; enables the high-fidelity batch exporter).
- `.env` at repo root with GitLab credentials — see `.env.example`.

### Platform deploy target (build-time bake)

The recommended deploy path bakes the bundle **on the platform's build
step** rather than committing it into git. Runtime containers never
touch GitLab; the build container does the heavy lifting once per
deploy.

Platform build environment needs:
- Node.js 18+
- Git CLI + **Git LFS** installed on the build container
- Env vars for the bake step (see below)
- Enough ephemeral disk for the Aegis clone (~several GB) + the
  resulting bundle (~hundreds of MB)

Runtime container needs:
- Node.js 18+
- Nothing else — the bundle is self-contained.

### Committed-bundle deploy target (alternative)

If you'd rather bake locally and commit `data/bundle/` via Git LFS,
see "Committing the bundle" below. Runtime host then only needs `git
lfs pull` during deploy and no GitLab access. This works for
platforms with tight build-time resource limits.

## Quick start (dev)

```bash
npm install
npm run dev
```

- API:  http://localhost:3101 (override via `LEVEL_VIEWER_PORT`)
- Web:  http://localhost:5173 (Vite proxies `/api` + `/ws` to the API)

On first start (when `AUTO_SYNC_ON_START=true`) the server sparse-clones
the Unity repo into `./data/repos/projectaegis/` (Assets/** only).

## Baking a deploy bundle

Either run it locally (`npm run bake`) or let the platform do it via
`npm run platform-build` — the output is the same.

```
data/bundle/
  manifest.json                 # scene list + GUID → blob map
  scenes/<relPath>.json         # per-scene render payload
  blobs/<guid><ext>             # ONLY the textures/meshes scenes reference
  fbx-materials/<guid>.json     # character/weapon external-material packs
```

Textures are downsampled to 1024 px / compressed to PNG at bake time,
so the deployed server doesn't need `sharp` / `@lunapaint/tga-codec` /
`ag-psd`. Meshes are bundled verbatim.

The bake is **incremental** — re-running skips blobs already on disk.
Delete `data/bundle/` to force a full rebake.

## Deploying — platform build-time bake (recommended)

Simplest possible flow for any host that can run Node:

```bash
git clone <aegisgram-repo>
cd aegisgram
npm start
```

That's it. `npm start` is an orchestrator that, in order:
1. Runs `npm ci --include=dev` if `node_modules/` is empty.
2. Builds the web client into `web/dist/` if not already there.
3. Builds the server into `server/dist/` if not already there.
4. Bakes `data/bundle/` if missing **and** `GITLAB_REPO2_URL` is set.
5. Launches `node server/dist/index.js`.

Every step is idempotent — second and subsequent boots skip straight
to step 5, so restarts are fast.

The server auto-detects `data/bundle/manifest.json` and runs in bundle
mode. `GET /api/health` reports `{"mode":"bundle", ...}`.

### Explicit build/start split (optional)

If your platform prefers a conventional build-then-start separation
(e.g. Heroku build images vs dyno runtime), use:

- **Build command:** `npm ci && npm run platform-build`
  (= `bake` → `build`)
- **Start command:** `npm run start:server-only`
  (skips the orchestrator; runs `node server/dist/index.js` directly)

This is purely a performance choice — the zero-config `npm start`
path produces the same artifacts.

### Required env vars on the platform

| Var                             | Stage       | Value                                                   |
| ------------------------------- | ----------- | ------------------------------------------------------- |
| `GITLAB_REPO2_URL`              | build       | Aegis repo HTTPS URL.                                   |
| `GITLAB_REPO2_TOKEN`            | build       | GitLab Personal Access Token (read_repository).         |
| `AEGISGRAM_POST_BAKE_CLEANUP`   | build       | `1` to delete `data/repos/` after bake (saves disk).    |
| `AEGISGRAM_IFRAME_ORIGINS`      | runtime     | Space-separated origins allowed to embed in `<iframe>`. |
| `PORT`                          | runtime     | Usually auto-injected by the platform.                  |
| `NODE_ENV`                      | runtime     | `production`.                                           |

> The `GITLAB_*` vars are consumed only during `npm run platform-build`;
> the runtime process never references them because `bundleMode` is
> active (the server auto-relaxes the "required" validation when a
> bundle is present). You can scope them to the build step if your
> platform allows it.

### Resource sizing

- Build container: ≥ 8 GB disk, ≥ 2 GB RAM. The Aegis sparse checkout
  + LFS pull commonly runs 2–5 GB peak. Set
  `AEGISGRAM_POST_BAKE_CLEANUP=1` to reclaim disk after the bundle is
  written.
- Runtime container: ≥ 512 MB RAM. The bundle reads are streamed; the
  manifest stays resident in memory (< 10 MB for a few hundred scenes).

### Build-time gotchas

- **Git LFS must be installed on the build container.** Render /
  Railway / Fly have it preinstalled; on Cloud Run buildpacks you may
  need a prebuild hook (`apt-get install -y git-lfs`).
- The bake can take **10–30 minutes** on first run depending on Aegis
  repo size and platform CPU. Subsequent builds reuse the cloned
  `data/repos/` if your platform preserves the build cache; otherwise
  it's a fresh clone every time.
- The platform's build timeout must accommodate this — default 15 min
  Render/Railway settings may be tight for a cold bake.

## Alternative: locally baked + committed bundle

If your platform's build step is too restricted (Vercel serverless,
Cloudflare Workers) or the bake is too slow to fit the build window,
bake once locally and commit `data/bundle/` via Git LFS.

The easy path is the bundled orchestrator:

```bash
npm install
npm run publish-bundle                 # bake (incremental) + stage + commit + push
```

That script is `scripts/publish-bundle.mjs` — it runs the bake,
verifies `manifest.json`, stages ONLY the bundle paths (so unrelated
WIP edits stay uncommitted), writes a timestamped commit message
carrying the scene count + source revision, and pushes to the
current branch's upstream. Useful flags:

- `npm run publish-bundle -- --skip-bake` — commit the bundle on
  disk as-is (skips step 1, handy if the bake just ran).
- `npm run publish-bundle -- --no-push` — local commit only, push
  by hand later.

Or the manual equivalent if you prefer wiring it yourself:

```bash
npm install
npm run bake                           # creates data/bundle/
git lfs install                        # one-time per clone
git add .gitattributes data/bundle
git commit -m "chore: refresh content bundle"
git push
```

Then on the platform:
```bash
git clone <aegisgram-repo>
cd aegisgram
git lfs install
git lfs pull                           # materializes data/bundle/blobs/*
npm ci
npm run build
npm start
```

Git LFS is configured for `data/bundle/blobs/**`,
`data/bundle/scenes/**`, and `data/bundle/fbx-materials/**`. The
manifest stays as plain text so PR diffs surface bake metadata.

## Environment variable reference

| Var                             | Mode          | Purpose                                                   |
| ------------------------------- | ------------- | --------------------------------------------------------- |
| `PORT`                          | both          | Platform-injected port (Render / Railway / Fly).          |
| `LEVEL_VIEWER_PORT`             | both          | Dev-only override (wins over `PORT` if set).              |
| `AEGISGRAM_BUNDLE_DIR`          | both          | Override bundle path (default `./data/bundle`).           |
| `AEGISGRAM_IFRAME_ORIGINS`      | bundle        | Space-separated origins allowed to embed in `<iframe>`.   |
| `AEGISGRAM_POST_BAKE_CLEANUP`   | bake          | `1` to remove `data/repos/` + `data/unity-export/`.       |
| `GITLAB_REPO2_URL`              | live / bake   | Aegis repo URL (unused at runtime in bundle mode).        |
| `GITLAB_REPO2_TOKEN`            | live / bake   | Personal access token.                                    |
| `LEVEL_VIEWER_GIT_FETCH_LFS`    | live / bake   | `true` during bake (auto-forced). Optional in live dev.   |
| `UNITY_EDITOR_PATH`             | bake          | Path to Unity Editor for the batch exporter.              |
| `AUTO_SYNC_ON_START`            | live          | `true` to pull Aegis at startup.                          |

In bundle mode, `/api/rebake` and `/api/sync` return HTTP 501 — the
server has no Unity Editor and no GitLab access, so those operations
are intentionally unavailable.

## iframe embedding

Aegisgram sets `Content-Security-Policy: frame-ancestors 'self' <origins>`
where `<origins>` comes from `AEGISGRAM_IFRAME_ORIGINS`. Example for a
production platform at `platform.example.com`:

```bash
AEGISGRAM_IFRAME_ORIGINS="https://platform.example.com"
```

Multiple origins are space-separated. Unset → only same-origin framing
is allowed.

## MVP scope & design notes

- Transform, MeshRenderer (material color + main texture), Directional
  Light.
- Custom meshes are rendered as grey box proxies in the YAML-parser
  path; the Unity batch exporter covers full geometry + URP material
  props.
- Unity (LH, Y-up) to Three.js (RH, Y-up) coordinate conversion via
  X-axis flip.

See `.cursor/plans/aegis_level_viewer_mvp_*.plan.md` and
`.cursor/plans/aegisgram_bundle_deploy_*.plan.md` for full design
notes.

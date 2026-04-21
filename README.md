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

### Bake workstation

Anyone who can successfully run the app in **live mode** can produce a
bundle. No extra dependencies.

### Deploy target (bundle mode)

- Node.js 18+
- **`git lfs pull` in the deploy step** — the bundle's textures/FBXes
  are stored in LFS. Without this the server refuses to start with a
  clear error message.
- **No Unity, no GitLab access, no Git LFS at runtime** — everything
  the server needs is in `data/bundle/`.

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

Run once on a workstation that has a working live-mode setup:

```bash
npm run bake
```

This produces `data/bundle/`:

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

### Committing the bundle

```bash
git lfs install              # one-time per clone
git add .gitattributes data/bundle
git commit -m "chore: refresh content bundle"
git push
```

Git LFS is configured for `data/bundle/blobs/**`, `data/bundle/scenes/**`
and `data/bundle/fbx-materials/**` (see `.gitattributes`). The manifest
itself stays as plain text so PR diffs surface bake metadata.

## Deploying (bundle mode)

Any host that can run Node + `git lfs pull`. Tested-shape deploy:

```bash
git clone <aegisgram-repo>
cd aegisgram
git lfs install
git lfs pull                           # REQUIRED — pulls data/bundle/blobs/*
npm ci
npm run build                          # builds server + web client
npm start                              # listens on LEVEL_VIEWER_PORT (3101)
```

The server auto-detects bundle mode by the presence of
`data/bundle/manifest.json`. `GET /api/health` reports `mode: "bundle"`.

### Environment variables

| Var                         | Mode          | Purpose                                                   |
| --------------------------- | ------------- | --------------------------------------------------------- |
| `LEVEL_VIEWER_PORT`         | both          | Server port (default `3101`).                             |
| `AEGISGRAM_BUNDLE_DIR`      | both          | Override bundle path (default `./data/bundle`).           |
| `AEGISGRAM_IFRAME_ORIGINS`  | bundle        | Space-separated origins allowed to embed in `<iframe>`.   |
| `GITLAB_REPO2_URL`          | live / bake   | Aegis repo URL (unused in bundle mode).                   |
| `GITLAB_REPO2_TOKEN`        | live / bake   | Personal access token.                                    |
| `UNITY_EDITOR_PATH`         | bake          | Path to Unity Editor for the batch exporter.              |
| `AUTO_SYNC_ON_START`        | live          | `true` to pull Aegis at startup.                          |

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

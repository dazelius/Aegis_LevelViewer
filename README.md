# Aegis Level Viewer

Web-based viewer for Unity scenes in the Project Aegis repository.

## Architecture

- **server/** - Node.js + Express + TypeScript backend
  - Syncs `GITLAB_REPO2_URL` via sparse/shallow git clone
  - Parses Unity `.unity` (YAML) scene files into JSON
  - Serves textures and a REST API on `PORT` (default `3001`)
- **web/** - React + Vite + react-three-fiber frontend
  - Lists available scenes, renders a selected scene with Three.js

## Prerequisites

- Node.js 18+
- Git CLI on PATH
- Valid `.env` at repo root (see existing `.env` for required keys)

## Quick start

```bash
npm install
npm run dev
```

- Server: http://localhost:3101 (override via `LEVEL_VIEWER_PORT`)
- Web:    http://localhost:5173

> The shared `.env` may already set `PORT=3001` for another service. We ignore
> that here and use a dedicated `LEVEL_VIEWER_PORT` (default `3101`) so this
> app doesn't clash.

On first start (when `AUTO_SYNC_ON_START=true`) the server will sparse-clone
the Unity repo into `./data/repos/projectaegis/` (Assets/** only).

## MVP scope

- Transform, MeshRenderer (material color + main texture), Directional Light
- Custom meshes are rendered as grey box proxies
- Unity (LH, Y-up) to Three.js (RH, Y-up) coordinate conversion via X-axis flip

See `.cursor/plans/aegis_level_viewer_mvp_*.plan.md` for full design notes.

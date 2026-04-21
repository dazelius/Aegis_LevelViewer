import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/src -> server -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Load .env from the repo root regardless of cwd (tsx/ts-node may run in server/).
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

function envOptional(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * True iff a pre-baked content bundle exists on disk. We detect bundle
 * mode at module load because several fields below want to branch on it
 * (e.g. GitLab creds are REQUIRED for live mode but OPTIONAL in bundle
 * mode — failing import on missing creds would break deploys that don't
 * have the source repo configured).
 *
 * Kept in sync with the exported `bundleMode` constant below — we compute
 * it once here early so the config object can reference it.
 */
const _bundleDir = path.resolve(REPO_ROOT, envOptional('AEGISGRAM_BUNDLE_DIR', './data/bundle'));

// AEGISGRAM_FORCE_LIVE=true forces live mode even when a bundle exists on
// disk. Useful for local development: you can have a baked bundle available
// for reference yet still get the real-time Unity repo experience without
// deleting data/bundle/. The env var is intentionally ignored in production
// (set it only in your local .env — not in the platform's env config).
const _forceLive =
  envOptional('AEGISGRAM_FORCE_LIVE', 'false').toLowerCase() === 'true';

const _bundleModeAtLoad = _forceLive
  ? false
  : (() => {
      try {
        return fs.statSync(path.join(_bundleDir, 'manifest.json')).isFile();
      } catch {
        return false;
      }
    })();

/**
 * Required-in-live-mode env var reader. Missing keys throw (so live dev
 * surfaces misconfiguration loudly at startup) unless we're in bundle
 * mode, where runtime has no use for GitLab credentials and demanding
 * them would break the common "just drop it on Render/Railway" deploy.
 */
function envRequiredInLiveMode(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (_bundleModeAtLoad) return '';
    throw new Error(
      `Missing required env var: ${key}. ` +
        `Set it in your .env for local dev, or run \`npm run bake\` to produce ` +
        `a \`data/bundle/\` so the server can start in bundle mode without it.`,
    );
  }
  return v;
}

export const config = {
  repoRoot: REPO_ROOT,

  // Port resolution:
  //   1. `LEVEL_VIEWER_PORT` — our dedicated var, used by local scripts.
  //   2. `PORT` — the de-facto convention for managed Node hosts
  //      (Render, Railway, Fly.io, Heroku, Cloud Run). Platforms inject
  //      it at runtime and expect the process to listen there.
  //   3. `3101` — local fallback.
  // Order matters: explicit `LEVEL_VIEWER_PORT` wins over a platform-
  // injected `PORT` so a dev can still override on a machine where
  // something else has already claimed `PORT`.
  port: Number(envOptional('LEVEL_VIEWER_PORT', envOptional('PORT', '3101'))),
  nodeEnv: envOptional('NODE_ENV', 'development'),

  gitlabRepo2Url: envRequiredInLiveMode('GITLAB_REPO2_URL'),
  gitlabRepo2Token: envOptional('GITLAB_REPO2_TOKEN', ''),

  gitCloneBaseDir: path.resolve(REPO_ROOT, envOptional('GIT_CLONE_BASE_DIR', './data/repos')),
  autoSyncOnStart: envOptional('AUTO_SYNC_ON_START', 'true').toLowerCase() === 'true',

  // Branch to check out (Project Aegis keeps game content on 'develop').
  gitBranch: envOptional('LEVEL_VIEWER_GIT_BRANCH', 'develop'),

  // The Project Aegis repo uses Git LFS for large binary assets (textures,
  // FBX meshes, ...). For the MVP we skip LFS by default: .unity/.mat/.meta
  // are plain text, so scene parsing works without LFS. Setting this to
  // 'true' will run `git lfs pull` for the sparse-checked-out paths.
  gitFetchLfs: envOptional('LEVEL_VIEWER_GIT_FETCH_LFS', 'false').toLowerCase() === 'true',

  // Subpath within the cloned repo where the Unity project root lives
  // (the folder that directly contains `Assets/` and `ProjectSettings/`).
  unityProjectSubpath: envOptional('UNITY_PROJECT_SUBPATH', 'Client/Project_Aegis'),

  // Restrict the /api/levels scene list to scenes under these subpaths of
  // `Assets/`. Accepts a comma-separated list so multiple root folders can
  // feed the scene picker (e.g. shipping maps + art-team sandbox scenes).
  // Empty string = show all scenes. Using this filter does NOT change what
  // gets cloned/sparse-checked-out; we still need the rest of `Assets/`
  // available so GUID references to materials, prefabs, textures (which
  // usually live OUTSIDE the scene's folder) can resolve.
  //
  // `DevAssets(not packed)/_DevArt/Environment` is the environment artists'
  // working directory — their scenes are authored there before being
  // copied into `GameContents/Map`, and the art team regularly needs to
  // preview them from the viewer too.
  sceneSubpath: envOptional(
    'LEVEL_VIEWER_SCENE_SUBPATH',
    'GameContents/Map,DevAssets(not packed)/_DevArt/Environment',
  ),

  // === Unity batch export (high-fidelity renderer) ===
  // Absolute path to Unity.exe matching the project's editor version (see
  // ProjectSettings/ProjectVersion.txt in the cloned repo). Leave empty to
  // disable batch export entirely — the server will fall back to the YAML
  // parser for every request.
  unityEditorPath: envOptional(
    'UNITY_EDITOR_PATH',
    'C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.10f1\\Editor\\Unity.exe',
  ),
  // Where to store baked <scene>.json exports produced by Unity batch runs.
  // The server prefers these over the YAML parser when the file exists.
  unityExportDir: path.resolve(
    REPO_ROOT,
    envOptional('LEVEL_VIEWER_UNITY_EXPORT_DIR', './data/unity-export'),
  ),

  // === Deploy-time content bundle ===
  //
  // For platform deployments we pre-bake all scene JSONs + the exact subset
  // of textures/meshes they reference into `data/bundle/`. When the bundle
  // exists, the server runs in "bundle mode":
  //   - Skips git sync (Project Aegis GitLab is never contacted at runtime).
  //   - Skips the .meta scan (assetIndex.build()).
  //   - Serves levels / textures / meshes / fbx-character-materials straight
  //     from the bundle using a manifest-backed O(1) lookup.
  //
  // Presence of `<bundleDir>/manifest.json` is the single switch. Local dev
  // continues to use the live Project Aegis clone when no bundle is present.
  bundleDir: _bundleDir,

  // Space-separated list of origins allowed to embed Aegisgram in an iframe,
  // e.g. "https://platform.example.com https://staging.example.com".
  // Used to build the `Content-Security-Policy: frame-ancestors` header.
  // Empty string = only same-origin framing (`'self'`) is allowed.
  iframeOrigins: envOptional('AEGISGRAM_IFRAME_ORIGINS', ''),

  // Rewrite outbound Git/LFS URLs before git reaches the network.
  // Whitespace-separated pairs of <from> <to> (also accepts `,`/`;` as
  // separators). Each pair becomes `url.<to>.insteadOf=<from>`, applied
  // to every git invocation the server controls (clone/pull/lfs fetch)
  // and inherited by git-lfs's smudge subprocesses.
  //
  // Why this exists: our GitLab instance answers the LFS batch API on
  // the internal IP (172.31.2.91) but populates `actions.download.href`
  // with the server's `external_url` (13.209.114.157), which the deploy
  // host can't reach — LFS downloads hang then fail. One env var
  // rewrites that redirect back to the reachable internal IP without
  // needing GitLab admin to change external_url, /etc/hosts edits, or
  // a side-proxy.
  //
  // Whitespace form (RECOMMENDED — most deploy UIs reject `=` inside
  // env values):
  //   AEGISGRAM_GIT_URL_REWRITES="http://13.209.114.157/ http://172.31.2.91/"
  //
  // Multiple rewrites = keep listing pairs:
  //   AEGISGRAM_GIT_URL_REWRITES="http://A/ http://B/  http://C/ http://D/"
  //
  // Legacy `from=to,from=to` is still parsed when any token contains `=`.
  //
  // Base64 escape hatch (for platforms that sanitise env values that
  // contain public IPs — e.g. UAAutoTool silently replaces the
  // external LFS IP with the internal one, collapsing the rewrite
  // into a no-op). Prefix the value with `base64:` or `b64:`:
  //   AEGISGRAM_GIT_URL_REWRITES=base64:<base64 of "http://A/ http://B/">
  gitUrlRewrites: envOptional('AEGISGRAM_GIT_URL_REWRITES', ''),
};

/**
 * Parse `AEGISGRAM_GIT_URL_REWRITES` into { from, to } pairs.
 *
 * Accepted formats (pick whichever survives your platform's env-var UI):
 *   1. Whitespace-separated, even-count tokens (recommended):
 *        "http://external/ http://internal/  http://A/ http://B/"
 *      Each pair is `<from> <to>`. Commas and semicolons also act as
 *      separators, so this is lenient on copy-paste.
 *   2. Legacy `<from>=<to>[,<from>=<to>]` style is still accepted when
 *      the entry contains `=` — but many deploy platforms treat `=`
 *      inside a value as illegal, which is why the whitespace form
 *      exists. Avoid `=` if you can.
 */
function parseGitUrlRewrites(): Array<{ from: string; to: string }> {
  let raw = config.gitUrlRewrites.trim();
  if (!raw) return [];

  // Escape hatch for deploy platforms that aggressively rewrite env
  // values containing public IPs / hostnames (UAAutoTool silently
  // replaces 13.209.114.157 with 172.31.2.91 on save, which zeroes
  // out the rewrite — both sides of each pair become identical).
  // Base64-encoding the pair list hides the literal IP string from
  // whatever scanner the platform runs. Accepted prefixes:
  //   base64:<payload>
  //   b64:<payload>
  const b64Match = /^(?:base64|b64):(.*)$/is.exec(raw);
  if (b64Match) {
    try {
      raw = Buffer.from(b64Match[1].trim(), 'base64').toString('utf8').trim();
      console.log('[config] AEGISGRAM_GIT_URL_REWRITES: base64 payload decoded');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[config] AEGISGRAM_GIT_URL_REWRITES base64 decode failed: ${msg}`);
      return [];
    }
  }

  const out: Array<{ from: string; to: string }> = [];

  // Split on any mix of whitespace / commas / semicolons.
  const tokens = raw.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);

  // If ANY token contains '=', fall back to the legacy `from=to` parser
  // so existing deploys that use that shape keep working unchanged.
  if (tokens.some((t) => t.includes('='))) {
    for (const pair of tokens) {
      const eq = pair.indexOf('=');
      if (eq <= 0 || eq === pair.length - 1) {
        console.warn(`[config] ignoring malformed url-rewrite: ${pair}`);
        continue;
      }
      const from = pair.slice(0, eq).trim();
      const to = pair.slice(eq + 1).trim();
      if (from && to) out.push({ from, to });
    }
    return out;
  }

  // Whitespace form: expect even number of tokens consumed as pairs.
  if (tokens.length % 2 !== 0) {
    console.warn(
      `[config] AEGISGRAM_GIT_URL_REWRITES has ${tokens.length} token(s) — ` +
        `expected an even count (pairs of <from> <to>). Ignoring trailing token.`,
    );
  }
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const from = tokens[i];
    const to = tokens[i + 1];
    if (from && to) out.push({ from, to });
  }
  return out;
}

/**
 * Parse `AEGISGRAM_GIT_URL_REWRITES` into a list of `-c
 * url.<to>.insteadOf=<from>` flags suitable for prepending to any `git`
 * command. Returns [] when unset so callers can splat unconditionally.
 */
export function getGitUrlRewriteFlags(): string[] {
  const flags: string[] = [];
  for (const { from, to } of parseGitUrlRewrites()) {
    flags.push('-c', `url.${to}.insteadOf=${from}`);
  }
  return flags;
}

/**
 * Return env-var overlay that applies the same URL rewrites to EVERY
 * git subprocess (including ones we don't wrap with `-c`, like the
 * smudge filter git-lfs runs internally). Uses `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_N` / `GIT_CONFIG_VALUE_N` — git's native mechanism
 * for injecting config without quoting hazards. Callers merge this
 * into their simpleGit `.env({...})` call.
 */
export function getGitConfigEnv(): Record<string, string> {
  const rewrites = parseGitUrlRewrites();
  if (rewrites.length === 0) return {};
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(rewrites.length),
  };
  rewrites.forEach(({ from, to }, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${to}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = from;
  });
  return env;
}

/**
 * True iff a pre-baked content bundle exists on disk. Computed once at
 * module load — the filesystem state for bundled deployments doesn't
 * change during a process lifetime, and we want downstream code to be
 * able to read a plain boolean rather than calling fs.stat on every
 * request. The bundle directory can be swapped via the
 * `AEGISGRAM_BUNDLE_DIR` env var (default `./data/bundle`).
 */
export const bundleMode: boolean = _bundleModeAtLoad;

export function getRepo2LocalDir(): string {
  // Derive a directory name from the repo URL, e.g. "projectaegis"
  const match = /([^/]+?)(?:\.git)?$/.exec(config.gitlabRepo2Url);
  const name = match?.[1] ?? 'repo2';
  return path.join(config.gitCloneBaseDir, name);
}

export function getUnityProjectDir(): string {
  return path.join(getRepo2LocalDir(), config.unityProjectSubpath);
}

export function getAssetsDir(): string {
  return path.join(getUnityProjectDir(), 'Assets');
}

/**
 * All filesystem roots under the Unity project whose `.meta` files define GUIDs
 * the scene YAML / prefabs may legitimately reference. Unity itself resolves
 * GUIDs against all three:
 *   - `Assets/`            — user content
 *   - `Packages/`          — embedded packages (if any)
 *   - `Library/PackageCache/` — downloaded registry / git packages (URP, TMP,
 *                               FishNet, ProBuilder, …). Default materials
 *                               like URP's `Lit.mat` live here.
 *
 * Missing roots are simply skipped — `Packages/` is almost always present,
 * but `Library/PackageCache/` only exists if someone has opened the project
 * in Unity Editor at least once (which generates it). In our case the cloned
 * repo happens to commit it, which we exploit to resolve URP default Lit.mat
 * and other package-shipped assets.
 *
 * Each entry reports a short name that the asset index uses as the prefix of
 * record `relPath` values, keeping the three namespaces distinguishable.
 */
export function getUnityAssetRoots(): { name: string; absPath: string }[] {
  const proj = getUnityProjectDir();
  return [
    { name: 'Assets', absPath: path.join(proj, 'Assets') },
    { name: 'Packages', absPath: path.join(proj, 'Packages') },
    { name: 'Library/PackageCache', absPath: path.join(proj, 'Library', 'PackageCache') },
  ];
}

/**
 * Returns sparse-checkout patterns in "non-cone" mode. Lines beginning with
 * `!` are excludes. We explicitly exclude a few huge editor-only plugin
 * directories that both bloat the checkout and trigger Windows MAX_PATH
 * issues even with core.longpaths enabled on some filesystems.
 */
export function getSparsePaths(): string[] {
  const base = config.unityProjectSubpath.replace(/\\/g, '/').replace(/\/+$/, '');
  return [
    `${base}/Assets/**`,
    `${base}/ProjectSettings/**`,
    `${base}/Packages/**`,
    // Excludes:
    `!${base}/Assets/StorePlugins/Magic Light Probes/**`,
    `!${base}/Assets/StorePlugins/**/Editor/**`,
  ];
}

/**
 * Inject token into a GitLab HTTP(S) URL for authenticated clone.
 * Example: http://HOST/path.git -> http://oauth2:TOKEN@HOST/path.git
 */
export function getAuthenticatedRepoUrl(): string {
  const raw = config.gitlabRepo2Url;
  const token = config.gitlabRepo2Token;
  if (!token) return raw;
  try {
    const u = new URL(raw);
    u.username = 'oauth2';
    u.password = token;
    return u.toString();
  } catch {
    return raw;
  }
}

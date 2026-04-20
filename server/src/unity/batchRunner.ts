import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, getUnityProjectDir } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/src/unity -> server -> unity-editor-script/<file>
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'unity-editor-script');
const EDITOR_SCRIPT_SRC = path.join(SCRIPTS_DIR, 'LevelViewerExporter.cs');
const EDITOR_SCRIPT_META_SRC = EDITOR_SCRIPT_SRC + '.meta';
const ODIN_STUBS_SRC = path.join(SCRIPTS_DIR, 'OdinInspectorStubs.cs');
const ODIN_STUBS_META_SRC = ODIN_STUBS_SRC + '.meta';
const AEGIS_SHIMS_SRC = path.join(SCRIPTS_DIR, 'AegisNamespaceShims.cs');
const AEGIS_SHIMS_META_SRC = AEGIS_SHIMS_SRC + '.meta';

/**
 * Root of a mirror tree that overwrites specific files in the Unity
 * project before batch runs. Each `.cs` file under this directory is
 * copied to the same relative path inside the project's `Assets/…`,
 * replacing whatever the original tree contained. This is for files
 * whose TYPE NAME is referenced by FishNet core but whose original
 * implementation has compile-breaking dependencies on missing assets.
 */
const AEGIS_REPLACE_DIR = path.join(SCRIPTS_DIR, 'aegis-restore');

/**
 * Paths (relative to the Unity project root) of Project Aegis source files
 * that reference third-party packages not committed to the repo (AWS SDK,
 * FishNet Pro, etc.) and cannot be fixed with a simple namespace stub.
 *
 * The batch runner deletes these files + their .meta file immediately
 * before invoking Unity. The source tree on disk is restored on the next
 * `git reset --hard`, so this is non-destructive as long as we don't
 * commit the repo back upstream.
 *
 * Deleting is safe for LEVEL VIEWER purposes because:
 *   - Level viewer only reads static scene geometry + materials + lights.
 *   - Missing MonoBehaviour scripts become "Missing Script" components on
 *     GameObjects when Unity opens the scene. The scene still loads and
 *     every other component (MeshRenderer, Light, etc.) still exports.
 *   - These files contain networking/AWS/telemetry logic we don't need.
 *
 * Note: we deliberately DO NOT delete core FishNet files like
 * NetworkManager.cs or DefaultPrefabObjects.cs. Those only `using`-import
 * the missing namespaces; the empty shims are enough for them.
 */
const FILES_TO_DELETE: readonly string[] = [
  // FishNet Runtime — non-core utility/stats components
  'Assets/StorePlugins/FishNet/Runtime/Managing/Client/Object/ObjectCaching_Aegis.cs',
  'Assets/StorePlugins/FishNet/Runtime/Generated/Component/Utility/BandwidthDisplay.cs',
  'Assets/StorePlugins/FishNet/Upgrading/MirrorUpgrade.cs',
  // NetworkTrafficStatistics is NOT in this list — the original file
  // references missing FishNet Pro types, BUT core FishNet Runtime also
  // references the TYPE NAME (StatisticsManager, TransportManager, etc.).
  // We replace the original with a no-op stub from `AEGIS_REPLACE_DIR`.

  // Project Aegis custom AWS-backed networking/logging
  'Assets/GameSources/NetworkClient/NetPlay/Character/Skill/ActionNode/Actions/PlayWeaponDraw.cs',
  'Assets/GameSources/NetworkDev/CloudWatchLogger.cs',
  'Assets/GameSources/NetworkDev/GameEventMessage.cs',
  'Assets/GameSources/NetworkDev/NetworkManagerGameLift_Aegis.cs',
  'Assets/GameSources/ScriptDev/Pulse/CBenchmarkManager.cs',
  'Assets/Network(server only)/LogShipper.cs',

  // Editor-only tools that depend on AWS SDK or FishNet Pro
  'Assets/GameSources/ScriptTools/Editor/NetworkTrafficWindow.cs',
  'Assets/GameSources/ScriptTools/Editor/DataExportTool/ToolCore/AutoUploader.cs',
  'Assets/GameSources/ScriptTools/Editor/DataExportTool/ToolCore/CToolReferenceTableManager.cs',
  'Assets/GameSources/ScriptTools/Editor/DataExportTool/ToolCore/DataExportTool.cs',
  'Assets/GameSources/ScriptTools/Editor/DataExportTool/ToolCore/DataExportToolEvent.cs',
  'Assets/GameSources/ScriptTools/Editor/DataExportTool/ToolCore/S3Manager.cs',
];

/**
 * Folders (relative to the Unity project root) where the namespace shim
 * file must be dropped. Each is a separate C# assembly (its own asmdef or
 * part of Assembly-CSharp), and namespaces declared in one assembly are
 * NOT visible to another unless that assembly references it, so the shim
 * has to be compiled independently into each.
 */
const SHIM_DROP_TARGETS: readonly string[] = [
  'Assets/LevelViewerShims', // -> Assembly-CSharp
  'Assets/StorePlugins/FishNet/Runtime/LevelViewerShims', // -> FishNet.Runtime
];

/**
 * Location of the copied editor script inside the Unity project. We keep it
 * under `Assets/Editor/LevelViewer/` — a dedicated subfolder makes cleanup
 * trivial and avoids polluting any existing Editor folder. Unity compiles
 * everything under `Assets/Editor/**` into `Assembly-CSharp-Editor.dll` so
 * MenuItems and `-executeMethod` resolve without any extra asmdef work.
 */
function getInjectedScriptDir(): string {
  return path.join(getUnityProjectDir(), 'Assets', 'Editor', 'LevelViewer');
}

export interface BatchExportOptions {
  /** Repo-relative scene path, e.g. `GameContents/Map/DesertMine/DesertMine.unity`.
   *  We translate to an absolute "Assets/..." path before passing to Unity. */
  relPath: string;
  /** Called with each line of Unity log output as it's produced. Useful for
   *  streaming progress to a websocket / SSE later; unused by the core run. */
  onLogLine?: (line: string) => void;
  /** Hard ceiling on a single Unity run. Unity's first-cold-start on a
   *  19k-asset project can legitimately take 15 min on a fresh Library, so
   *  the default is generous. */
  timeoutMs?: number;
}

export interface BatchExportResult {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  outPath: string;
  logPath: string;
  /** Tail of the Unity log (last ~200 lines) — handy for returning to the
   *  client on failure without ballooning the response size. */
  logTail: string;
  /** Set when we failed before even launching Unity (missing editor, project
   *  locked, editor script copy failed, ...). */
  preflightError?: string;
}

export interface BatchStatus {
  state: 'idle' | 'running' | 'success' | 'failed';
  relPath?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  outPath?: string;
  logPath?: string;
  error?: string;
  /** Most recent batch the user triggered — retained for a single slot. */
}

/**
 * We gate runs through a single-slot mutex. Unity's batch mode acquires an
 * exclusive lock on the project Library folder, so concurrent runs on the
 * same project would fail with cryptic "EditorUserBuildSettings" errors.
 */
let inFlight: Promise<BatchExportResult> | null = null;
let currentStatus: BatchStatus = { state: 'idle' };

export function getBatchStatus(): BatchStatus {
  return currentStatus;
}

/**
 * Run the Unity Editor in batch mode to export a scene to our rich JSON
 * format. Blocks until Unity exits (or the timeout fires). Safe to call
 * concurrently: the second caller will await the first run.
 */
export async function runUnityExport(opts: BatchExportOptions): Promise<BatchExportResult> {
  if (inFlight) {
    // Same scene → piggyback on the in-flight run. Different scene → serialize.
    // We keep it dumb (always serialize) to avoid a second concurrent lock
    // attempt on the project; callers can re-request after the first finishes.
    return inFlight;
  }

  const promise = doRun(opts);
  inFlight = promise;
  try {
    return await promise;
  } finally {
    inFlight = null;
  }
}

async function doRun(opts: BatchExportOptions): Promise<BatchExportResult> {
  const started = Date.now();

  const projectDir = getUnityProjectDir();
  const outPath = path.join(
    config.unityExportDir,
    opts.relPath.replace(/\\/g, '/').replace(/\.unity$/i, '') + '.json',
  );
  const logPath = path.join(
    config.unityExportDir,
    '_logs',
    `${Date.now()}_${path.basename(opts.relPath, '.unity')}.log`,
  );

  currentStatus = {
    state: 'running',
    relPath: opts.relPath,
    startedAt: started,
    outPath,
    logPath,
  };

  const preflight = await preflightChecks(projectDir);
  if (preflight) {
    currentStatus = {
      ...currentStatus,
      state: 'failed',
      finishedAt: Date.now(),
      durationMs: Date.now() - started,
      error: preflight,
    };
    return {
      ok: false,
      exitCode: -1,
      durationMs: Date.now() - started,
      outPath,
      logPath,
      logTail: '',
      preflightError: preflight,
    };
  }

  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await injectEditorScript(projectDir);
    await patchManifestForBatch(projectDir);
  } catch (err) {
    const msg = (err as Error).message;
    currentStatus = {
      ...currentStatus,
      state: 'failed',
      finishedAt: Date.now(),
      durationMs: Date.now() - started,
      error: `setup failed: ${msg}`,
    };
    return {
      ok: false,
      exitCode: -1,
      durationMs: Date.now() - started,
      outPath,
      logPath,
      logTail: '',
      preflightError: `setup failed: ${msg}`,
    };
  }

  // Assets-root-relative path for the Unity side. The editor script will
  // further normalize (absolute → Assets/… if needed) but we pass it in the
  // already-correct form here.
  const sceneAssetPath = 'Assets/' + opts.relPath.replace(/\\/g, '/');

  const args = [
    '-batchmode',
    '-nographics',
    '-quit',
    '-silent-crashes',
    '-accept-apiupdate',
    '-projectPath',
    projectDir,
    '-executeMethod',
    'LevelViewerExporter.ExportCli',
    '-exportScene',
    sceneAssetPath,
    '-exportOut',
    outPath,
    '-logFile',
    logPath,
  ];

  console.log('[batchRunner] spawn Unity.exe', args.join(' '));

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(config.unityEditorPath, args, {
      windowsHide: true,
    });

    // We only rely on -logFile for Unity's actual log; anything to stdout is
    // early startup noise, but we forward it just in case it contains fatal
    // errors (e.g. license activation) before the log file is open.
    const forward = (buf: Buffer) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line) opts.onLogLine?.(line);
      }
    };
    proc.stdout?.on('data', forward);
    proc.stderr?.on('data', forward);

    const timeout = setTimeout(
      () => {
        console.warn('[batchRunner] TIMEOUT — killing Unity');
        proc.kill('SIGKILL');
      },
      opts.timeoutMs ?? 20 * 60 * 1000,
    );

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? -1);
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[batchRunner] spawn error:', err);
      resolve(-1);
    });
  });

  const durationMs = Date.now() - started;
  const logTail = await readLogTail(logPath, 200);

  // Success is "exit code 0 AND output file exists". Unity's batch mode has
  // historically returned 0 even on certain compile errors, so we also check
  // that the exporter actually wrote the expected file.
  const outExists = await pathExists(outPath);
  const ok = exitCode === 0 && outExists;

  currentStatus = {
    state: ok ? 'success' : 'failed',
    relPath: opts.relPath,
    startedAt: started,
    finishedAt: started + durationMs,
    durationMs,
    outPath,
    logPath,
    error: ok ? undefined : `exit=${exitCode} outExists=${outExists}`,
  };

  return {
    ok,
    exitCode,
    durationMs,
    outPath,
    logPath,
    logTail,
  };
}

/**
 * Verify that batch export is even possible before we try to start Unity.
 * Returns an error string when something's off, `null` when we're good to go.
 */
async function preflightChecks(projectDir: string): Promise<string | null> {
  if (!config.unityEditorPath) return 'UNITY_EDITOR_PATH not configured';
  if (!fsSync.existsSync(config.unityEditorPath)) {
    return `Unity editor not found at ${config.unityEditorPath}`;
  }
  if (!fsSync.existsSync(path.join(projectDir, 'Assets'))) {
    return `Unity project not found at ${projectDir} (did git sync run?)`;
  }
  if (!fsSync.existsSync(EDITOR_SCRIPT_SRC)) {
    return `Editor script source missing at ${EDITOR_SCRIPT_SRC}`;
  }

  // Detect the single most common batch-mode failure: someone has the project
  // open in the Unity Editor, which holds an exclusive Library lock.
  const lockFile = path.join(projectDir, 'Temp', 'UnityLockfile');
  if (fsSync.existsSync(lockFile)) {
    // Not 100% reliable — Unity sometimes leaves this behind after a crash —
    // but we surface it as a warning rather than hard-failing so the user
    // can decide. Empirically if the file is there AND the process is
    // actually running, the spawn below fails fast with an obvious error.
    console.warn(`[batchRunner] WARNING: UnityLockfile present at ${lockFile}`);
  }
  return null;
}

/**
 * Copy our exporter .cs + .meta into the Unity project's Assets/Editor tree.
 * This runs right before every batch invocation because `git sync` can wipe
 * untracked files via `git reset --hard`. The destination directory is
 * outside the `Assets/` sparse patterns the sync itself uses, but the
 * `.cs.meta` carries a fixed GUID so Unity re-compiles the Assembly-CSharp-
 * Editor.dll without regenerating metadata every run.
 *
 * We also drop `OdinInspectorStubs.cs` into a RUNTIME folder
 * (`Assets/LevelViewerShims/`) so it compiles into Assembly-CSharp — some of
 * Project Aegis' third-party scripts under `Assets/StorePlugins/FishNet/`
 * reference Odin Inspector attributes, and without these shims the runtime
 * assembly fails to compile, which in turn prevents our Editor assembly
 * (and hence `LevelViewerExporter.ExportCli`) from loading.
 */
async function injectEditorScript(projectDir: string): Promise<void> {
  // --- exporter (editor-only assembly) ---
  const editorDir = getInjectedScriptDir();
  await fs.mkdir(editorDir, { recursive: true });

  await fs.copyFile(EDITOR_SCRIPT_SRC, path.join(editorDir, 'LevelViewerExporter.cs'));
  if (fsSync.existsSync(EDITOR_SCRIPT_META_SRC)) {
    await fs.copyFile(EDITOR_SCRIPT_META_SRC, path.join(editorDir, 'LevelViewerExporter.cs.meta'));
  }

  // --- Odin stubs (runtime assembly) ---
  //
  // Project Aegis splits the main Assembly-CSharp into many per-folder
  // asmdefs. A stub in `Assets/LevelViewerShims/` lands in Assembly-CSharp
  // but is INVISIBLE to code inside a folder with its own asmdef. Each
  // asmdef that consumes Odin attributes thus needs the stubs compiled
  // into IT specifically. We drop a copy into every known location that
  // has failed at compile time so far. Empirically these are the ones
  // Project Aegis uses Odin Inspector against; add more as necessary.
  if (fsSync.existsSync(ODIN_STUBS_SRC)) {
    const stubTargets = [
      // Main Assembly-CSharp (for user scripts without an asmdef).
      'Assets/LevelViewerShims',
      // GameKit.Dependencies.asmdef — FishNet's GameKit utility subtree.
      'Assets/StorePlugins/FishNet/Runtime/Plugins/GameKit/Dependencies',
    ];
    for (const rel of stubTargets) {
      const absDir = path.join(projectDir, rel);
      if (!fsSync.existsSync(absDir)) continue;
      await fs.copyFile(ODIN_STUBS_SRC, path.join(absDir, 'OdinInspectorStubs.cs'));
      // Intentionally DO NOT copy the .meta file when dropping into
      // third-party folders — Unity would fail with "GUID already in use"
      // if the same meta GUID lands in multiple assemblies. Letting Unity
      // auto-generate per-folder metas sidesteps that. We only ship a
      // fixed-GUID .meta for the LevelViewerShims location since it's our
      // own folder.
      if (rel === 'Assets/LevelViewerShims' && fsSync.existsSync(ODIN_STUBS_META_SRC)) {
        await fs.copyFile(ODIN_STUBS_META_SRC, path.join(absDir, 'OdinInspectorStubs.cs.meta'));
      }
    }
  }

  // --- Aegis namespace shims (every asmdef that imports missing namespaces) ---
  if (fsSync.existsSync(AEGIS_SHIMS_SRC)) {
    for (const rel of SHIM_DROP_TARGETS) {
      const absDir = path.join(projectDir, rel);
      await fs.mkdir(absDir, { recursive: true });
      await fs.copyFile(AEGIS_SHIMS_SRC, path.join(absDir, 'AegisNamespaceShims.cs'));
      // Only ship a fixed .meta into our own LevelViewerShims folder to
      // avoid GUID collisions across assemblies; let Unity auto-generate
      // the FishNet one.
      if (rel === 'Assets/LevelViewerShims' && fsSync.existsSync(AEGIS_SHIMS_META_SRC)) {
        await fs.copyFile(
          AEGIS_SHIMS_META_SRC,
          path.join(absDir, 'AegisNamespaceShims.cs.meta'),
        );
      }
    }
  }

  // --- replace specific files with no-op stubs (see AEGIS_REPLACE_DIR) ---
  //
  // These are files whose TYPE is required for compilation by FishNet core
  // but whose implementation references missing assets. We keep the file
  // (and, ideally, the same .meta GUID) so that scene-level references
  // still resolve to a valid MonoScript, but swap the body for a stub.
  if (fsSync.existsSync(AEGIS_REPLACE_DIR)) {
    await copyTreeOverwriting(AEGIS_REPLACE_DIR, projectDir);
  }

  // --- delete files that reference missing third-party assets ---
  //
  // These files can't be rescued with namespace stubs alone because they
  // instantiate real types from the missing packages (AmazonSQSClient,
  // BidirectionalNetworkTraffic, etc.). We delete the .cs and its .meta;
  // the next `git reset --hard` (via sync) will restore them unchanged.
  // Scene-level references to the deleted MonoBehaviour scripts become
  // "Missing Script" components, which Unity tolerates — the scene still
  // opens and all non-script components export normally.
  for (const rel of FILES_TO_DELETE) {
    const abs = path.join(projectDir, rel);
    for (const suffix of ['', '.meta']) {
      const p = abs + suffix;
      try {
        await fs.unlink(p);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.warn(`[batchRunner] failed to delete ${p}:`, err);
        }
      }
    }
  }

  // Folder .meta files — Unity needs one per new folder to avoid
  // "Folder is not registered" warnings that pollute the log and slow down
  // AssetDatabase.Refresh.
  const foldersNeedingMeta = [
    'Assets/Editor',
    'Assets/Editor/LevelViewer',
    ...SHIM_DROP_TARGETS,
  ];
  for (const part of foldersNeedingMeta) {
    const abs = path.join(projectDir, part);
    const meta = abs + '.meta';
    if (!fsSync.existsSync(meta)) {
      const guid = cryptoRandomHex(32);
      const content = `fileFormatVersion: 2\nguid: ${guid}\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n`;
      await fs.writeFile(meta, content, 'utf8');
    }
  }
}

/**
 * Packages/manifest.json in Project Aegis references several local tarball
 * packages (e.g. `file:../com.amazonaws.gamelift-2.1.0.tgz`) that aren't
 * committed to the git repo — each developer keeps them locally from the
 * original vendor download. For our read-only batch viewer pipeline, we
 * don't need those runtime dependencies; Unity's Package Manager refuses to
 * resolve and exits with "Tarball package ... cannot be found", which blocks
 * the entire export. We work around this by filtering out any dependency
 * pointing at a local file: URL whose target doesn't exist on disk.
 *
 * The modification is applied fresh each run because `git sync` uses
 * `git reset --hard` and will have reverted the file. We DON'T commit the
 * cleaned manifest back to git.
 */
async function patchManifestForBatch(projectDir: string): Promise<void> {
  const manifestPath = path.join(projectDir, 'Packages', 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    console.warn('[batchRunner] Could not parse manifest.json, skipping patch:', err);
    return;
  }
  const deps = manifest.dependencies ?? {};
  const removed: string[] = [];
  for (const [pkg, ver] of Object.entries(deps)) {
    // We only touch file: URLs. Other specs (semver, git:, scoped-registry)
    // work even when network is limited because Unity caches them.
    if (!ver.startsWith('file:')) continue;
    // Resolve the file path relative to Packages/
    const rel = ver.substring('file:'.length);
    const abs = path.resolve(path.join(projectDir, 'Packages'), rel);
    if (!fsSync.existsSync(abs)) {
      removed.push(pkg);
      delete deps[pkg];
    }
  }
  if (removed.length === 0) return;
  console.log(
    `[batchRunner] patchManifestForBatch: removed ${removed.length} missing-tarball dep(s):`,
    removed.join(', '),
  );
  manifest.dependencies = deps;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Unity regenerates `packages-lock.json` from `manifest.json` on next
  // resolve. The existing lock file, however, carries the full set of
  // resolved packages (including the ones we just removed) and Unity will
  // happily "heal" the manifest from the lock, reintroducing the broken
  // tarball references. Deleting the lock lets Package Manager start fresh.
  const lockPath = path.join(projectDir, 'Packages', 'packages-lock.json');
  if (fsSync.existsSync(lockPath)) {
    await fs.rm(lockPath);
  }
}

/**
 * Recursively copy every file under `srcRoot` to the same relative path
 * under `dstRoot`, overwriting whatever exists there. Directories are
 * created as needed. We intentionally preserve the destination's existing
 * `.meta` file for each copied `.cs` so that Unity's MonoScript GUID
 * doesn't change (which would break scene component references).
 */
async function copyTreeOverwriting(srcRoot: string, dstRoot: string): Promise<void> {
  const stack: string[] = [srcRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(srcPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(srcRoot, srcPath);
      const dstPath = path.join(dstRoot, rel);
      await fs.mkdir(path.dirname(dstPath), { recursive: true });
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

function cryptoRandomHex(len: number): string {
  const bytes = new Uint8Array(len / 2);
  // Node 18+ exposes globalThis.crypto.getRandomValues synchronously.
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function readLogTail(logPath: string, lines: number): Promise<string> {
  try {
    const buf = await fs.readFile(logPath, 'utf8');
    const allLines = buf.split(/\r?\n/);
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute path to the baked JSON for a given scene relPath.
 * Independent of whether the file actually exists — callers typically
 * `fs.stat` this to decide whether to prefer it over the YAML parser.
 */
export function bakedJsonPathFor(relPath: string): string {
  return path.join(
    config.unityExportDir,
    relPath.replace(/\\/g, '/').replace(/\.unity$/i, '') + '.json',
  );
}

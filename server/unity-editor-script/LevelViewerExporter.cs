// SPDX-License-Identifier: MIT
// LevelViewerExporter.cs — Tier 1 high-fidelity Unity scene exporter
//
// This file is NOT meant to live in the project repo permanently. The Level
// Viewer's batch runner copies it into <project>/Assets/Editor/ right before
// each export run (and our git sync's `reset --hard` wipes it on next pull).
// Keeping the canonical copy under server/unity-editor-script/ avoids us
// having to coordinate Unity-project-level commits every time the exporter
// changes.
//
// What it produces:
//   <outPath>.json   — self-contained scene description (nodes, meshes,
//                      materials, lights, render settings). All geometry is
//                      encoded as base64 typed-array blobs inline; textures
//                      are referenced by Unity GUID so the web server can
//                      serve them via its existing /api/assets/texture route.
//
// Coordinate convention in the output JSON matches Three.js world space:
//   - X axis is flipped compared to Unity (Unity is left-handed, three.js
//     right-handed). Positions, mesh vertex positions, and normals all have
//     their X component negated server-side during export. Triangle winding
//     is reversed so faces still point the right way.
//   - Rotations (quaternions) are mirrored equivalently: (x, -y, -z, w).
// The web client can therefore consume the JSON without any further coord
// conversion, keeping renderer code simple.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static class LevelViewerExporter
{
    const string FORMAT_VERSION = "unity-export@1";

    // ---------------------------------------------------------------- CLI ----

    /// <summary>
    /// Batch-mode entry point. Invoked via:
    ///   Unity.exe -batchmode -nographics -quit \
    ///     -projectPath &lt;proj&gt; \
    ///     -executeMethod LevelViewerExporter.ExportCli \
    ///     -exportScene &lt;absolute scene path&gt; \
    ///     -exportOut   &lt;absolute output json path&gt; \
    ///     -logFile     &lt;log path&gt;
    /// </summary>
    public static void ExportCli()
    {
        int exitCode = 0;
        try
        {
            string scenePath = GetArg("-exportScene");
            string outPath = GetArg("-exportOut");

            if (string.IsNullOrEmpty(scenePath) || string.IsNullOrEmpty(outPath))
            {
                Log("FATAL: Missing -exportScene or -exportOut CLI arg");
                exitCode = 2;
                return;
            }

            DoExport(scenePath, outPath);
        }
        catch (Exception ex)
        {
            Log("FATAL: " + ex);
            exitCode = 1;
        }
        finally
        {
            // EditorApplication.Exit ensures Unity closes even when something
            // left a modal dialog queued up (e.g. "do you want to save scene").
            EditorApplication.Exit(exitCode);
        }
    }

    [MenuItem("Tools/Level Viewer/Export Current Scene")]
    public static void ExportCurrentMenu()
    {
        var scene = SceneManager.GetActiveScene();
        string outRoot = Path.GetFullPath(Path.Combine(Application.dataPath, "../LevelViewerExports"));
        string outFile = Path.Combine(outRoot, Path.GetFileNameWithoutExtension(scene.path) + ".json");
        DoExport(scene.path, outFile);
        Debug.Log("[LevelViewerExporter] Wrote " + outFile);
    }

    static string GetArg(string name)
    {
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == name) return args[i + 1];
        }
        return null;
    }

    static void Log(string msg) { Console.WriteLine("[LevelViewerExporter] " + msg); }

    // ---------------------------------------------------------- Main export ----

    static void DoExport(string scenePathArg, string outPath)
    {
        // Normalize to an asset-relative path ("Assets/...") because
        // EditorSceneManager.OpenScene requires that form.
        string scenePath = NormalizeScenePath(scenePathArg);
        Log("Opening scene: " + scenePath);

        var scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
        if (!scene.IsValid())
        {
            throw new Exception("Failed to open scene: " + scenePath);
        }

        // Force all queued asset imports (including deferred FBX imports that
        // can be pending right after a fresh git checkout) to finish before
        // we start querying sharedMesh / sharedMaterial data.
        AssetDatabase.Refresh();

        var ctx = new ExportContext();
        ctx.SceneName = scene.name;
        ctx.ScenePath = scenePath;

        CaptureRenderSettings(ctx);

        var roots = scene.GetRootGameObjects();
        Log($"Walking {roots.Length} root GameObject(s)...");
        foreach (var root in roots)
        {
            WalkNode(root, parentId: -1, ctx);
        }

        Log($"Nodes: {ctx.Nodes.Count} | Meshes: {ctx.Meshes.Count} | " +
            $"Materials: {ctx.Materials.Count} | Textures: {ctx.TextureGuids.Count} | " +
            $"Lights: {ctx.LightCount}");

        string dir = Path.GetDirectoryName(outPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        string json = JsonEmitter.Emit(ctx);
        File.WriteAllText(outPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        Log("Wrote " + outPath + " (" + new FileInfo(outPath).Length + " bytes)");
    }

    static string NormalizeScenePath(string p)
    {
        string asset = p.Replace('\\', '/');
        int idx = asset.IndexOf("Assets/", StringComparison.OrdinalIgnoreCase);
        if (idx >= 0) asset = asset.Substring(idx);
        return asset;
    }

    // --------------------------------------------------------- Render settings ----

    static void CaptureRenderSettings(ExportContext ctx)
    {
        ctx.AmbientMode = RenderSettings.ambientMode.ToString();
        ctx.AmbientSkyColor = ColorToArr(RenderSettings.ambientSkyColor);
        ctx.AmbientEquatorColor = ColorToArr(RenderSettings.ambientEquatorColor);
        ctx.AmbientGroundColor = ColorToArr(RenderSettings.ambientGroundColor);
        ctx.AmbientLight = ColorToArr(RenderSettings.ambientLight);
        ctx.AmbientIntensity = RenderSettings.ambientIntensity;

        ctx.FogEnabled = RenderSettings.fog;
        ctx.FogColor = ColorToArr(RenderSettings.fogColor);
        ctx.FogMode = RenderSettings.fogMode.ToString();
        ctx.FogDensity = RenderSettings.fogDensity;
        ctx.FogStart = RenderSettings.fogStartDistance;
        ctx.FogEnd = RenderSettings.fogEndDistance;

        if (RenderSettings.skybox != null)
        {
            ctx.SkyboxMaterialGuid = MaterialGuid(RenderSettings.skybox);
            ctx.SkyboxShaderName = RenderSettings.skybox.shader != null
                ? RenderSettings.skybox.shader.name
                : null;
        }
    }

    // ----------------------------------------------------------- Scene walk ----

    static void WalkNode(GameObject go, int parentId, ExportContext ctx)
    {
        // Skip editor-only helpers that shouldn't appear in a preview viewer
        // (reflection probe cameras, gizmo-only GOs, etc. aren't flagged
        // explicitly by Unity — we keep everything but editor-hidden flags).
        if ((go.hideFlags & HideFlags.HideInHierarchy) != 0) return;

        int myId = ctx.Nodes.Count;
        var node = new NodeData
        {
            Id = myId,
            ParentId = parentId,
            Name = go.name,
            Active = go.activeSelf,
            Layer = go.layer,
            Tag = go.tag,
        };

        var t = go.transform;
        // Coord convert: see file header. Unity (LH) -> three.js (RH) = mirror X.
        node.Position = new[] { -t.localPosition.x, t.localPosition.y, t.localPosition.z };
        Quaternion lr = t.localRotation;
        node.Rotation = new[] { lr.x, -lr.y, -lr.z, lr.w };
        node.Scale = new[] { t.localScale.x, t.localScale.y, t.localScale.z };

        // --- renderer ---
        var smr = go.GetComponent<SkinnedMeshRenderer>();
        var mr = go.GetComponent<MeshRenderer>();
        var mf = go.GetComponent<MeshFilter>();

        if (smr != null && smr.sharedMesh != null)
        {
            // Pose the mesh into its current skinned state. `useScale: true`
            // bakes any scale on the root into the vertices so downstream
            // renderers don't have to reproduce the skinning pipeline.
            var posed = new Mesh { name = smr.sharedMesh.name + "_baked" };
            try
            {
                smr.BakeMesh(posed, useScale: true);
                string meshId = ctx.InternMeshFromInstance(posed, smr.sharedMesh);
                node.Mesh = BuildMeshRef(meshId, smr, ctx);
            }
            catch (Exception ex)
            {
                Log("BakeMesh failed for " + go.name + ": " + ex.Message);
                UnityEngine.Object.DestroyImmediate(posed);
            }
        }
        else if (mr != null && mf != null && mf.sharedMesh != null)
        {
            string meshId = ctx.InternMeshAsset(mf.sharedMesh);
            node.Mesh = BuildMeshRef(meshId, mr, ctx);
        }

        // --- light ---
        var light = go.GetComponent<Light>();
        if (light != null)
        {
            node.Light = new LightRef
            {
                Type = light.type.ToString(),
                Color = ColorToArr(light.color),
                Intensity = light.intensity,
                Range = light.range,
                SpotAngle = light.spotAngle,
                InnerSpotAngle = light.innerSpotAngle,
                Shadows = light.shadows.ToString(),
                ShadowStrength = light.shadowStrength,
                ColorTemperature = light.useColorTemperature ? light.colorTemperature : 0f,
                UseColorTemperature = light.useColorTemperature,
                Bounce = light.bounceIntensity,
                LightmapBakeType = light.lightmapBakeType.ToString(),
            };
            ctx.LightCount++;
        }

        // --- camera ---
        var cam = go.GetComponent<Camera>();
        if (cam != null)
        {
            node.Camera = new CameraRef
            {
                Fov = cam.fieldOfView,
                Near = cam.nearClipPlane,
                Far = cam.farClipPlane,
                Orthographic = cam.orthographic,
                OrthoSize = cam.orthographicSize,
                ClearFlags = cam.clearFlags.ToString(),
                BackgroundColor = ColorToArr(cam.backgroundColor),
            };
        }

        ctx.Nodes.Add(node);

        foreach (Transform child in go.transform)
        {
            WalkNode(child.gameObject, myId, ctx);
        }
    }

    static MeshRef BuildMeshRef(string meshId, Renderer r, ExportContext ctx)
    {
        var mats = r.sharedMaterials;
        var matIds = new List<string>(mats.Length);
        for (int i = 0; i < mats.Length; i++)
        {
            matIds.Add(mats[i] != null ? ctx.InternMaterial(mats[i]) : null);
        }

        return new MeshRef
        {
            MeshId = meshId,
            MaterialIds = matIds,
            CastShadows = r.shadowCastingMode.ToString(),
            ReceiveShadows = r.receiveShadows,
            LightmapIndex = r.lightmapIndex,
            LightmapScaleOffset = new[] {
                r.lightmapScaleOffset.x, r.lightmapScaleOffset.y,
                r.lightmapScaleOffset.z, r.lightmapScaleOffset.w
            },
        };
    }

    // ----------------------------------------------------------- Asset IDs ----

    static string MaterialGuid(Material m)
    {
        if (m == null) return null;
        string path = AssetDatabase.GetAssetPath(m);
        if (string.IsNullOrEmpty(path)) return null;
        return AssetDatabase.AssetPathToGUID(path);
    }

    // ----------------------------------------------------------- Util ----

    static float[] ColorToArr(Color c) => new[] { c.r, c.g, c.b, c.a };

    // =====================================================================
    // Context + pool objects
    // =====================================================================

    sealed class ExportContext
    {
        public string SceneName;
        public string ScenePath;

        // --- render settings ---
        public string AmbientMode;
        public float[] AmbientSkyColor;
        public float[] AmbientEquatorColor;
        public float[] AmbientGroundColor;
        public float[] AmbientLight;
        public float AmbientIntensity;
        public bool FogEnabled;
        public float[] FogColor;
        public string FogMode;
        public float FogDensity;
        public float FogStart;
        public float FogEnd;
        public string SkyboxMaterialGuid;
        public string SkyboxShaderName;

        // --- tree ---
        public List<NodeData> Nodes = new List<NodeData>();

        // --- dedup pools. Meshes are keyed by instance ID so we reuse between
        //     every MeshFilter that references the same sharedMesh. Materials
        //     likewise. Textures go into a set so the server can report which
        //     guids a scene actually needs (useful for LFS pre-fetch later). ---
        public Dictionary<int, string> MeshIdByInstanceID = new Dictionary<int, string>();
        public Dictionary<string, MeshData> Meshes = new Dictionary<string, MeshData>();
        public Dictionary<int, string> MaterialIdByInstanceID = new Dictionary<int, string>();
        public Dictionary<string, MaterialData> Materials = new Dictionary<string, MaterialData>();
        public HashSet<string> TextureGuids = new HashSet<string>();

        public int LightCount;

        public string InternMeshAsset(Mesh m)
        {
            int iid = m.GetInstanceID();
            if (MeshIdByInstanceID.TryGetValue(iid, out var existing)) return existing;
            string id = "m_" + Meshes.Count.ToString("x");
            MeshIdByInstanceID[iid] = id;
            Meshes[id] = MeshEncoder.Encode(m, id, isBaked: false);
            return id;
        }

        /// <summary>Baked (SkinnedMeshRenderer) meshes are transient — we can't
        /// dedupe them per-asset because each instance has distinct pose data.
        /// We still intern them so the JSON shape stays uniform, but each call
        /// gets its own ID.</summary>
        public string InternMeshFromInstance(Mesh posed, Mesh source)
        {
            string id = "mb_" + Meshes.Count.ToString("x");
            Meshes[id] = MeshEncoder.Encode(posed, id, isBaked: true, sourceAssetPath: source != null ? AssetDatabase.GetAssetPath(source) : null);
            return id;
        }

        public string InternMaterial(Material mat)
        {
            int iid = mat.GetInstanceID();
            if (MaterialIdByInstanceID.TryGetValue(iid, out var existing)) return existing;
            string id = "mat_" + Materials.Count.ToString("x");
            MaterialIdByInstanceID[iid] = id;
            Materials[id] = MaterialEncoder.Encode(mat, id, this);
            return id;
        }

        public void NoteTexture(string guid)
        {
            if (!string.IsNullOrEmpty(guid)) TextureGuids.Add(guid);
        }
    }

    sealed class NodeData
    {
        public int Id;
        public int ParentId;
        public string Name;
        public bool Active;
        public int Layer;
        public string Tag;
        public float[] Position;
        public float[] Rotation;
        public float[] Scale;

        public MeshRef Mesh;
        public LightRef Light;
        public CameraRef Camera;
    }

    sealed class MeshRef
    {
        public string MeshId;
        public List<string> MaterialIds;
        public string CastShadows;
        public bool ReceiveShadows;
        public int LightmapIndex;
        public float[] LightmapScaleOffset;
    }

    sealed class LightRef
    {
        public string Type;
        public float[] Color;
        public float Intensity;
        public float Range;
        public float SpotAngle;
        public float InnerSpotAngle;
        public string Shadows;
        public float ShadowStrength;
        public float ColorTemperature;
        public bool UseColorTemperature;
        public float Bounce;
        public string LightmapBakeType;
    }

    sealed class CameraRef
    {
        public float Fov;
        public float Near;
        public float Far;
        public bool Orthographic;
        public float OrthoSize;
        public string ClearFlags;
        public float[] BackgroundColor;
    }

    sealed class MeshData
    {
        public string Id;
        public string Name;
        public string SourceAssetPath;
        public bool IsBaked;
        public int VertexCount;
        public int IndexCount;
        public string PositionsB64;      // Float32, XYZ, X-flipped
        public string NormalsB64;        // Float32, XYZ or null
        public string TangentsB64;       // Float32, XYZW or null
        public string Uv0B64;            // Float32, XY or null
        public string Uv1B64;            // Float32, XY or null (lightmap)
        public string ColorsB64;         // Float32, RGBA or null
        public string IndicesB64;        // Uint32, winding-reversed
        public float[] AabbMin;
        public float[] AabbMax;
        public List<SubmeshData> Submeshes;
    }

    sealed class SubmeshData
    {
        public int Start;
        public int Count;
        public string Topology;
    }

    sealed class MaterialData
    {
        public string Id;
        public string Name;
        public string Guid;
        public string Shader;
        public string RenderMode;  // Opaque | Cutout | Transparent | Fade
        public string Cull;        // Back | Front | Off
        public float[] BaseColor;
        public string BaseMapGuid;
        public float[] BaseMapTiling;
        public float[] BaseMapOffset;
        public string NormalMapGuid;
        public float NormalScale;
        public float Metallic;
        public float Smoothness;
        public string MetallicGlossMapGuid;
        public bool SmoothnessFromAlbedoAlpha;
        public string OcclusionMapGuid;
        public float OcclusionStrength;
        public float[] EmissionColor;
        public string EmissionMapGuid;
        public float AlphaCutoff;
        public bool DoubleSided;
        public bool ReceivesFog;
        /// <summary>Catch-all bag of every other Color/Float/Tex property on
        /// the material, for debugging / forwards compat. Not intended for
        /// direct client rendering yet.</summary>
        public Dictionary<string, object> ExtraProperties;
    }

    // =====================================================================
    // Mesh encoder
    // =====================================================================

    static class MeshEncoder
    {
        public static MeshData Encode(Mesh m, string id, bool isBaked, string sourceAssetPath = null)
        {
            var d = new MeshData
            {
                Id = id,
                Name = m.name,
                IsBaked = isBaked,
                SourceAssetPath = sourceAssetPath ?? AssetDatabase.GetAssetPath(m),
                VertexCount = m.vertexCount,
            };

            // Positions: X-flipped (Unity LH → three RH)
            var positions = m.vertices;
            var pArr = new float[positions.Length * 3];
            float minX = float.PositiveInfinity, minY = float.PositiveInfinity, minZ = float.PositiveInfinity;
            float maxX = float.NegativeInfinity, maxY = float.NegativeInfinity, maxZ = float.NegativeInfinity;
            for (int i = 0; i < positions.Length; i++)
            {
                float x = -positions[i].x;
                float y = positions[i].y;
                float z = positions[i].z;
                pArr[i * 3 + 0] = x;
                pArr[i * 3 + 1] = y;
                pArr[i * 3 + 2] = z;
                if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
            }
            d.PositionsB64 = FloatsToB64(pArr);
            d.AabbMin = new[] { minX, minY, minZ };
            d.AabbMax = new[] { maxX, maxY, maxZ };

            // Normals: X-flipped too (mirroring axis flips face normals along X).
            if (m.normals != null && m.normals.Length == positions.Length)
            {
                var n = m.normals;
                var nArr = new float[n.Length * 3];
                for (int i = 0; i < n.Length; i++)
                {
                    nArr[i * 3 + 0] = -n[i].x;
                    nArr[i * 3 + 1] = n[i].y;
                    nArr[i * 3 + 2] = n[i].z;
                }
                d.NormalsB64 = FloatsToB64(nArr);
            }

            // Tangents: xyz mirror same as normals. The w component encodes
            // bitangent handedness; since we flipped triangle winding that w
            // must also flip sign to stay consistent.
            if (m.tangents != null && m.tangents.Length == positions.Length)
            {
                var t = m.tangents;
                var arr = new float[t.Length * 4];
                for (int i = 0; i < t.Length; i++)
                {
                    arr[i * 4 + 0] = -t[i].x;
                    arr[i * 4 + 1] = t[i].y;
                    arr[i * 4 + 2] = t[i].z;
                    arr[i * 4 + 3] = -t[i].w;
                }
                d.TangentsB64 = FloatsToB64(arr);
            }

            // UVs: unchanged (2D surface coords).
            if (m.uv != null && m.uv.Length == positions.Length)
            {
                var u = m.uv;
                var arr = new float[u.Length * 2];
                for (int i = 0; i < u.Length; i++) { arr[i * 2 + 0] = u[i].x; arr[i * 2 + 1] = u[i].y; }
                d.Uv0B64 = FloatsToB64(arr);
            }
            if (m.uv2 != null && m.uv2.Length == positions.Length)
            {
                var u = m.uv2;
                var arr = new float[u.Length * 2];
                for (int i = 0; i < u.Length; i++) { arr[i * 2 + 0] = u[i].x; arr[i * 2 + 1] = u[i].y; }
                d.Uv1B64 = FloatsToB64(arr);
            }

            if (m.colors != null && m.colors.Length == positions.Length)
            {
                var c = m.colors;
                var arr = new float[c.Length * 4];
                for (int i = 0; i < c.Length; i++)
                {
                    arr[i * 4 + 0] = c[i].r; arr[i * 4 + 1] = c[i].g;
                    arr[i * 4 + 2] = c[i].b; arr[i * 4 + 3] = c[i].a;
                }
                d.ColorsB64 = FloatsToB64(arr);
            }

            // Indices: winding-reversed (Xflip flips face orientation;
            // swapping indices 1↔2 in each triangle restores it).
            var tri = m.triangles;
            if (tri != null)
            {
                var reversed = new uint[tri.Length];
                for (int i = 0; i + 2 < tri.Length; i += 3)
                {
                    reversed[i + 0] = (uint)tri[i + 0];
                    reversed[i + 1] = (uint)tri[i + 2];
                    reversed[i + 2] = (uint)tri[i + 1];
                }
                d.IndicesB64 = UInt32sToB64(reversed);
                d.IndexCount = reversed.Length;
            }

            // Per-submesh ranges (so the client can map material slots to
            // triangle ranges even when a single mesh has multiple materials).
            d.Submeshes = new List<SubmeshData>(m.subMeshCount);
            for (int s = 0; s < m.subMeshCount; s++)
            {
                var sd = m.GetSubMesh(s);
                // Note: the indices we emit are already winding-reversed but
                // their CONTIGUOUS BLOCK still occupies the same [indexStart,
                // indexStart+indexCount) range. So these offsets stay valid.
                d.Submeshes.Add(new SubmeshData
                {
                    Start = sd.indexStart,
                    Count = sd.indexCount,
                    Topology = sd.topology.ToString(),
                });
            }

            return d;
        }

        static string FloatsToB64(float[] arr)
        {
            byte[] bytes = new byte[arr.Length * 4];
            Buffer.BlockCopy(arr, 0, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }

        static string UInt32sToB64(uint[] arr)
        {
            byte[] bytes = new byte[arr.Length * 4];
            Buffer.BlockCopy(arr, 0, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }
    }

    // =====================================================================
    // Material encoder — URP/Lit, Standard, and a generic fallback
    // =====================================================================

    static class MaterialEncoder
    {
        public static MaterialData Encode(Material m, string id, ExportContext ctx)
        {
            var d = new MaterialData
            {
                Id = id,
                Name = m.name,
                Guid = MaterialGuid(m),
                Shader = m.shader != null ? m.shader.name : null,
                ExtraProperties = new Dictionary<string, object>(),
            };

            // --- Detect shader family ---
            string shaderName = d.Shader ?? "";
            bool isURPLit = shaderName.StartsWith("Universal Render Pipeline/Lit") ||
                            shaderName.StartsWith("Universal Render Pipeline/Simple Lit") ||
                            shaderName.StartsWith("Universal Render Pipeline/Complex Lit") ||
                            shaderName.StartsWith("Universal Render Pipeline/Baked Lit");
            bool isURPUnlit = shaderName.StartsWith("Universal Render Pipeline/Unlit");

            string mainColorProp, mainMapProp;
            if (isURPLit || isURPUnlit)
            {
                mainColorProp = "_BaseColor";
                mainMapProp = "_BaseMap";
            }
            else
            {
                // Legacy Standard / Mobile / custom — try _Color/_MainTex first.
                mainColorProp = "_Color";
                mainMapProp = "_MainTex";
            }

            d.BaseColor = m.HasProperty(mainColorProp)
                ? ColorToArr(m.GetColor(mainColorProp))
                : new[] { 1f, 1f, 1f, 1f };

            if (m.HasProperty(mainMapProp))
            {
                d.BaseMapGuid = TextureGuid(m.GetTexture(mainMapProp), ctx);
                var tiling = m.GetTextureScale(mainMapProp);
                var offset = m.GetTextureOffset(mainMapProp);
                d.BaseMapTiling = new[] { tiling.x, tiling.y };
                d.BaseMapOffset = new[] { offset.x, offset.y };
            }

            // Normal map
            if (m.HasProperty("_BumpMap"))
                d.NormalMapGuid = TextureGuid(m.GetTexture("_BumpMap"), ctx);
            if (m.HasProperty("_BumpScale"))
                d.NormalScale = m.GetFloat("_BumpScale");

            // Metallic / Smoothness (URP Lit)
            if (m.HasProperty("_Metallic")) d.Metallic = m.GetFloat("_Metallic");
            if (m.HasProperty("_Smoothness")) d.Smoothness = m.GetFloat("_Smoothness");
            else if (m.HasProperty("_Glossiness")) d.Smoothness = m.GetFloat("_Glossiness");
            if (m.HasProperty("_MetallicGlossMap"))
                d.MetallicGlossMapGuid = TextureGuid(m.GetTexture("_MetallicGlossMap"), ctx);
            if (m.HasProperty("_SmoothnessTextureChannel"))
                d.SmoothnessFromAlbedoAlpha = Mathf.Approximately(m.GetFloat("_SmoothnessTextureChannel"), 1f);

            // Occlusion
            if (m.HasProperty("_OcclusionMap"))
                d.OcclusionMapGuid = TextureGuid(m.GetTexture("_OcclusionMap"), ctx);
            if (m.HasProperty("_OcclusionStrength"))
                d.OcclusionStrength = m.GetFloat("_OcclusionStrength");
            else d.OcclusionStrength = 1f;

            // Emission
            if (m.HasProperty("_EmissionColor"))
                d.EmissionColor = ColorToArr(m.GetColor("_EmissionColor"));
            else d.EmissionColor = new[] { 0f, 0f, 0f, 1f };
            if (m.HasProperty("_EmissionMap"))
                d.EmissionMapGuid = TextureGuid(m.GetTexture("_EmissionMap"), ctx);

            // Alpha cutoff
            if (m.HasProperty("_Cutoff")) d.AlphaCutoff = m.GetFloat("_Cutoff");
            else if (m.HasProperty("_AlphaClip")) d.AlphaCutoff = m.GetFloat("_AlphaClip");
            else d.AlphaCutoff = 0.5f;

            // Render mode: URP uses _Surface (0 Opaque, 1 Transparent) + _AlphaClip.
            // Legacy Standard uses _Mode (0 Opaque, 1 Cutout, 2 Fade, 3 Transparent).
            d.RenderMode = DetectRenderMode(m);

            // Culling: URP _Cull (0 Off, 1 Front, 2 Back). Mirror of many shaders.
            if (m.HasProperty("_Cull"))
            {
                int cull = (int)m.GetFloat("_Cull");
                d.Cull = cull == 0 ? "Off" : (cull == 1 ? "Front" : "Back");
            }
            else d.Cull = "Back";
            d.DoubleSided = d.Cull == "Off";

            // Capture any other simple property we didn't map above so the
            // client can later decide to consume more of them without us
            // having to re-export. Limited to color/float/texture types to
            // keep the JSON bounded.
            CaptureExtras(m, d);

            return d;
        }

        static string DetectRenderMode(Material m)
        {
            // URP style
            if (m.HasProperty("_Surface"))
            {
                float surface = m.GetFloat("_Surface"); // 0 opaque, 1 transparent
                bool clip = m.HasProperty("_AlphaClip") && m.GetFloat("_AlphaClip") > 0.5f;
                if (Mathf.Approximately(surface, 1f)) return "Transparent";
                return clip ? "Cutout" : "Opaque";
            }
            // Legacy Standard
            if (m.HasProperty("_Mode"))
            {
                int mode = (int)m.GetFloat("_Mode");
                switch (mode)
                {
                    case 0: return "Opaque";
                    case 1: return "Cutout";
                    case 2: return "Fade";
                    case 3: return "Transparent";
                }
            }
            // Heuristic: if the material has an AlphaClip-like keyword.
            if (m.IsKeywordEnabled("_ALPHATEST_ON")) return "Cutout";
            if (m.IsKeywordEnabled("_ALPHABLEND_ON") || m.IsKeywordEnabled("_SURFACE_TYPE_TRANSPARENT")) return "Transparent";
            return "Opaque";
        }

        static void CaptureExtras(Material m, MaterialData d)
        {
            // Unity doesn't expose a public list of properties on Material at
            // runtime, but Shader does via ShaderUtil. In Editor code that's
            // fine.
            if (m.shader == null) return;

            int propCount = ShaderUtil.GetPropertyCount(m.shader);
            for (int i = 0; i < propCount; i++)
            {
                string pname = ShaderUtil.GetPropertyName(m.shader, i);
                // Skip properties we already captured explicitly
                if (pname == "_BaseColor" || pname == "_BaseMap" || pname == "_Color" || pname == "_MainTex"
                    || pname == "_BumpMap" || pname == "_BumpScale" || pname == "_Metallic" || pname == "_Smoothness"
                    || pname == "_MetallicGlossMap" || pname == "_OcclusionMap" || pname == "_OcclusionStrength"
                    || pname == "_EmissionColor" || pname == "_EmissionMap" || pname == "_Cutoff" || pname == "_Cull"
                    || pname == "_Surface" || pname == "_AlphaClip" || pname == "_Mode") continue;

                var type = ShaderUtil.GetPropertyType(m.shader, i);
                switch (type)
                {
                    case ShaderUtil.ShaderPropertyType.Color:
                        d.ExtraProperties[pname] = ColorToArr(m.GetColor(pname));
                        break;
                    case ShaderUtil.ShaderPropertyType.Float:
                    case ShaderUtil.ShaderPropertyType.Range:
                        d.ExtraProperties[pname] = m.GetFloat(pname);
                        break;
                    case ShaderUtil.ShaderPropertyType.Vector:
                        var v = m.GetVector(pname);
                        d.ExtraProperties[pname] = new[] { v.x, v.y, v.z, v.w };
                        break;
                    case ShaderUtil.ShaderPropertyType.TexEnv:
                        var guid = TextureGuid(m.GetTexture(pname), null); // don't track extras
                        if (!string.IsNullOrEmpty(guid))
                        {
                            var tile = m.GetTextureScale(pname);
                            var off = m.GetTextureOffset(pname);
                            d.ExtraProperties[pname] = new Dictionary<string, object>
                            {
                                { "guid", guid },
                                { "tiling", new[] { tile.x, tile.y } },
                                { "offset", new[] { off.x, off.y } },
                            };
                        }
                        break;
                }
            }
        }

        static string TextureGuid(Texture tex, ExportContext ctx)
        {
            if (tex == null) return null;
            string path = AssetDatabase.GetAssetPath(tex);
            if (string.IsNullOrEmpty(path)) return null;
            string g = AssetDatabase.AssetPathToGUID(path);
            if (ctx != null) ctx.NoteTexture(g);
            return g;
        }
    }

    // =====================================================================
    // JSON emitter — hand-rolled to avoid dragging in Newtonsoft.Json as a
    // hard dependency. Fast enough for our scale (hundreds of KB output in
    // seconds). Keys are stable (insertion order) for diffability.
    // =====================================================================

    static class JsonEmitter
    {
        public static string Emit(ExportContext ctx)
        {
            var sb = new StringBuilder(1024 * 1024);
            var w = new JsonWriter(sb);

            w.Begin();
            w.Property("format", FORMAT_VERSION);
            w.Property("generator", "LevelViewerExporter/" + Application.unityVersion);
            w.Property("exportedAt", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ"));
            w.Property("scenePath", ctx.ScenePath);
            w.Property("sceneName", ctx.SceneName);

            // --- render settings ---
            w.Key("render"); w.BeginObject();
            w.Property("ambientMode", ctx.AmbientMode);
            w.PropertyFloatArr("ambientSkyColor", ctx.AmbientSkyColor);
            w.PropertyFloatArr("ambientEquatorColor", ctx.AmbientEquatorColor);
            w.PropertyFloatArr("ambientGroundColor", ctx.AmbientGroundColor);
            w.PropertyFloatArr("ambientLight", ctx.AmbientLight);
            w.Property("ambientIntensity", ctx.AmbientIntensity);
            w.Property("fogEnabled", ctx.FogEnabled);
            w.PropertyFloatArr("fogColor", ctx.FogColor);
            w.Property("fogMode", ctx.FogMode);
            w.Property("fogDensity", ctx.FogDensity);
            w.Property("fogStart", ctx.FogStart);
            w.Property("fogEnd", ctx.FogEnd);
            w.Property("skyboxMaterialGuid", ctx.SkyboxMaterialGuid);
            w.Property("skyboxShaderName", ctx.SkyboxShaderName);
            w.EndObject();

            // --- nodes (flat array; ParentId wires up the tree) ---
            w.Key("nodes"); w.BeginArray();
            foreach (var n in ctx.Nodes) EmitNode(w, n);
            w.EndArray();

            // --- meshes (keyed map for dedup reference) ---
            w.Key("meshes"); w.BeginObject();
            foreach (var kv in ctx.Meshes) { w.Key(kv.Key); EmitMesh(w, kv.Value); }
            w.EndObject();

            // --- materials ---
            w.Key("materials"); w.BeginObject();
            foreach (var kv in ctx.Materials) { w.Key(kv.Key); EmitMaterial(w, kv.Value); }
            w.EndObject();

            // --- texture guids referenced anywhere (for pre-fetch UX) ---
            w.Key("textureGuids"); w.BeginArray();
            foreach (var g in ctx.TextureGuids) w.Str(g);
            w.EndArray();

            w.End();
            return sb.ToString();
        }

        static void EmitNode(JsonWriter w, NodeData n)
        {
            w.BeginObject();
            w.Property("id", n.Id);
            w.Property("parentId", n.ParentId);
            w.Property("name", n.Name);
            w.Property("active", n.Active);
            w.Property("layer", n.Layer);
            w.Property("tag", n.Tag);
            w.PropertyFloatArr("position", n.Position);
            w.PropertyFloatArr("rotation", n.Rotation);
            w.PropertyFloatArr("scale", n.Scale);

            if (n.Mesh != null)
            {
                w.Key("mesh"); w.BeginObject();
                w.Property("meshId", n.Mesh.MeshId);
                w.Key("materialIds"); w.BeginArray();
                foreach (var mid in n.Mesh.MaterialIds) w.Str(mid);
                w.EndArray();
                w.Property("castShadows", n.Mesh.CastShadows);
                w.Property("receiveShadows", n.Mesh.ReceiveShadows);
                w.Property("lightmapIndex", n.Mesh.LightmapIndex);
                w.PropertyFloatArr("lightmapScaleOffset", n.Mesh.LightmapScaleOffset);
                w.EndObject();
            }
            if (n.Light != null)
            {
                w.Key("light"); w.BeginObject();
                w.Property("type", n.Light.Type);
                w.PropertyFloatArr("color", n.Light.Color);
                w.Property("intensity", n.Light.Intensity);
                w.Property("range", n.Light.Range);
                w.Property("spotAngle", n.Light.SpotAngle);
                w.Property("innerSpotAngle", n.Light.InnerSpotAngle);
                w.Property("shadows", n.Light.Shadows);
                w.Property("shadowStrength", n.Light.ShadowStrength);
                w.Property("colorTemperature", n.Light.ColorTemperature);
                w.Property("useColorTemperature", n.Light.UseColorTemperature);
                w.Property("bounce", n.Light.Bounce);
                w.Property("lightmapBakeType", n.Light.LightmapBakeType);
                w.EndObject();
            }
            if (n.Camera != null)
            {
                w.Key("camera"); w.BeginObject();
                w.Property("fov", n.Camera.Fov);
                w.Property("near", n.Camera.Near);
                w.Property("far", n.Camera.Far);
                w.Property("orthographic", n.Camera.Orthographic);
                w.Property("orthoSize", n.Camera.OrthoSize);
                w.Property("clearFlags", n.Camera.ClearFlags);
                w.PropertyFloatArr("backgroundColor", n.Camera.BackgroundColor);
                w.EndObject();
            }
            w.EndObject();
        }

        static void EmitMesh(JsonWriter w, MeshData d)
        {
            w.BeginObject();
            w.Property("name", d.Name);
            w.Property("sourceAssetPath", d.SourceAssetPath);
            w.Property("isBaked", d.IsBaked);
            w.Property("vertexCount", d.VertexCount);
            w.Property("indexCount", d.IndexCount);
            w.Property("positionsB64", d.PositionsB64);
            w.Property("normalsB64", d.NormalsB64);
            w.Property("tangentsB64", d.TangentsB64);
            w.Property("uv0B64", d.Uv0B64);
            w.Property("uv1B64", d.Uv1B64);
            w.Property("colorsB64", d.ColorsB64);
            w.Property("indicesB64", d.IndicesB64);
            w.PropertyFloatArr("aabbMin", d.AabbMin);
            w.PropertyFloatArr("aabbMax", d.AabbMax);
            w.Key("submeshes"); w.BeginArray();
            foreach (var s in d.Submeshes)
            {
                w.BeginObject();
                w.Property("start", s.Start);
                w.Property("count", s.Count);
                w.Property("topology", s.Topology);
                w.EndObject();
            }
            w.EndArray();
            w.EndObject();
        }

        static void EmitMaterial(JsonWriter w, MaterialData d)
        {
            w.BeginObject();
            w.Property("name", d.Name);
            w.Property("guid", d.Guid);
            w.Property("shader", d.Shader);
            w.Property("renderMode", d.RenderMode);
            w.Property("cull", d.Cull);
            w.PropertyFloatArr("baseColor", d.BaseColor);
            w.Property("baseMapGuid", d.BaseMapGuid);
            w.PropertyFloatArr("baseMapTiling", d.BaseMapTiling);
            w.PropertyFloatArr("baseMapOffset", d.BaseMapOffset);
            w.Property("normalMapGuid", d.NormalMapGuid);
            w.Property("normalScale", d.NormalScale);
            w.Property("metallic", d.Metallic);
            w.Property("smoothness", d.Smoothness);
            w.Property("metallicGlossMapGuid", d.MetallicGlossMapGuid);
            w.Property("smoothnessFromAlbedoAlpha", d.SmoothnessFromAlbedoAlpha);
            w.Property("occlusionMapGuid", d.OcclusionMapGuid);
            w.Property("occlusionStrength", d.OcclusionStrength);
            w.PropertyFloatArr("emissionColor", d.EmissionColor);
            w.Property("emissionMapGuid", d.EmissionMapGuid);
            w.Property("alphaCutoff", d.AlphaCutoff);
            w.Property("doubleSided", d.DoubleSided);
            w.Key("extra"); w.BeginObject();
            foreach (var kv in d.ExtraProperties)
            {
                w.Key(kv.Key);
                EmitExtra(w, kv.Value);
            }
            w.EndObject();
            w.EndObject();
        }

        static void EmitExtra(JsonWriter w, object v)
        {
            if (v is float f) w.Num(f);
            else if (v is int i) w.Num(i);
            else if (v is bool b) w.Bool(b);
            else if (v is float[] fa) w.FloatArr(fa);
            else if (v is Dictionary<string, object> dict)
            {
                w.BeginObject();
                foreach (var kv in dict) { w.Key(kv.Key); EmitExtra(w, kv.Value); }
                w.EndObject();
            }
            else if (v is string s) w.Str(s);
            else w.Null();
        }
    }

    sealed class JsonWriter
    {
        readonly StringBuilder _sb;
        // Track the "needs comma" state per scope so we can emit valid JSON
        // without re-scanning the buffer. Each scope = a frame on the stack.
        readonly Stack<bool> _first = new Stack<bool>();

        public JsonWriter(StringBuilder sb) { _sb = sb; }

        public void Begin() { _sb.Append('{'); _first.Push(true); }
        public void End() { _sb.Append('}'); _first.Pop(); }

        public void BeginObject() { Comma(); _sb.Append('{'); _first.Push(true); }
        public void EndObject() { _sb.Append('}'); _first.Pop(); }
        public void BeginArray() { Comma(); _sb.Append('['); _first.Push(true); }
        public void EndArray() { _sb.Append(']'); _first.Pop(); }

        public void Key(string name)
        {
            Comma();
            _sb.Append('"'); AppendEscaped(name); _sb.Append('"'); _sb.Append(':');
        }

        public void Property(string name, string v) { Key(name); Str(v); }
        public void Property(string name, bool v) { Key(name); Bool(v); }
        public void Property(string name, int v) { Key(name); Num(v); }
        public void Property(string name, float v) { Key(name); Num(v); }
        public void PropertyFloatArr(string name, float[] arr) { Key(name); FloatArr(arr); }

        public void Str(string s)
        {
            if (s == null) { _sb.Append("null"); return; }
            _sb.Append('"'); AppendEscaped(s); _sb.Append('"');
        }
        public void Bool(bool b) { _sb.Append(b ? "true" : "false"); }
        public void Null() { _sb.Append("null"); }
        public void Num(int i) { _sb.Append(i.ToString(CultureInfo.InvariantCulture)); }
        public void Num(float f)
        {
            if (float.IsNaN(f) || float.IsInfinity(f)) { _sb.Append("null"); return; }
            _sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
        }
        public void FloatArr(float[] arr)
        {
            if (arr == null) { _sb.Append("null"); return; }
            _sb.Append('[');
            for (int i = 0; i < arr.Length; i++)
            {
                if (i > 0) _sb.Append(',');
                Num(arr[i]);
            }
            _sb.Append(']');
        }

        // Emits a comma if we're not the first item in the current scope, and
        // flips the first-item flag.
        void Comma()
        {
            if (_first.Count == 0) return;
            bool first = _first.Pop();
            if (!first) _sb.Append(',');
            _first.Push(false);
        }

        void AppendEscaped(string s)
        {
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\b': _sb.Append("\\b"); break;
                    case '\f': _sb.Append("\\f"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    default:
                        if (c < ' ') _sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
                        else _sb.Append(c);
                        break;
                }
            }
        }
    }
}

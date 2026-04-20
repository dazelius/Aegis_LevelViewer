import type { RawDoc } from './sceneParser.js';

/**
 * Geometry decoded from a scene-embedded `!u!43 Mesh` document.
 *
 * Unity ProBuilder (and a handful of other authoring tools) store their meshes
 * inline inside the `.unity` / `.prefab` file as a `Mesh` sub-document, rather
 * than as an external `.fbx`. The vertex/index buffers are kept as hex strings
 * in `m_VertexData._typelessdata` and `m_IndexBuffer`.
 *
 * We decode just enough to render the geometry: positions + triangle indices.
 * Normals/UVs/colors/tangents are intentionally skipped — our client uses an
 * unlit MeshBasicMaterial so lighting data is irrelevant, and we already tint
 * with the material's base color.
 *
 * Transport format is base64 so the resulting JSON stays small. Each scene
 * with a few hundred inline meshes can easily push the payload into MB-range
 * if we use plain number arrays.
 */
export interface InlineMeshData {
  /** Base64-encoded Float32Array of XYZ positions, length = vertexCount*3. */
  positionsB64: string;
  /** Base64-encoded Uint32Array of triangle indices (winding reversed to
   *  compensate for the Unity→Three handedness flip). */
  indicesB64: string;
  vertexCount: number;
  indexCount: number;
  /** Axis-aligned bounding box in Three.js space. Useful for framing. */
  aabb?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

function num(v: unknown, fb = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  return fb;
}

function hexToBytes(hex: string): Uint8Array {
  // Unity YAML folds long hex strings across lines with whitespace indentation;
  // strip any non-hex characters defensively before decoding.
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const byteLen = clean.length >>> 1;
  const out = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i += 1) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

// Unity VertexAttributeFormat → byte size. Only Float32 is actually decoded
// for positions below; the rest are here so we can correctly compute stride.
const FORMAT_SIZES: Record<number, number> = {
  0: 4, // Float32
  1: 2, // Float16
  2: 1, // UNorm8
  3: 1, // SNorm8
  4: 1, // UInt8
  5: 1, // SInt8
  6: 2, // UInt16
  7: 2, // SInt16
  8: 2, // UNorm16
  9: 2, // SNorm16
  10: 4, // UInt32
  11: 4, // SInt32
};

/**
 * Decode the inline mesh from a class-43 Unity document, or `undefined` if
 * the mesh is empty / compressed / uses a vertex format we don't support.
 */
export function parseInlineMesh(doc: RawDoc): InlineMeshData | undefined {
  const body = doc.body;

  // Skip compressed meshes — their vertex data is packed in a separate
  // `m_CompressedMesh` object with a different encoding we don't handle yet.
  if (num(body['m_MeshCompression'], 0) !== 0) return undefined;

  const vd = body['m_VertexData'] as Record<string, unknown> | undefined;
  if (!vd) return undefined;

  const vertexCount = num(vd['m_VertexCount'], 0);
  if (vertexCount === 0) return undefined;

  const channels = Array.isArray(vd['m_Channels'])
    ? (vd['m_Channels'] as Array<Record<string, unknown>>)
    : [];
  // Position is always the first channel in Unity's vertex layout.
  const posChan = channels[0];
  if (!posChan) return undefined;
  const posFormat = num(posChan['format'], -1);
  const posDim = num(posChan['dimension'], 0);
  if (posFormat !== 0 || posDim !== 3) return undefined;
  const posOffset = num(posChan['offset'], 0);

  // Stride = end of the last populated channel. We compute it by max(offset +
  // byte_size) so we're robust to channels declared out of order.
  let stride = 0;
  for (const c of channels) {
    const dim = num(c['dimension'], 0);
    if (dim === 0) continue;
    const fmt = num(c['format'], 0);
    const sz = FORMAT_SIZES[fmt];
    if (sz === undefined) return undefined;
    stride = Math.max(stride, num(c['offset'], 0) + dim * sz);
  }
  if (stride === 0) return undefined;

  const typeless = vd['_typelessdata'];
  if (typeof typeless !== 'string' || typeless.length === 0) return undefined;
  const vertexBytes = hexToBytes(typeless);
  if (vertexBytes.length < vertexCount * stride) return undefined;

  const positions = new Float32Array(vertexCount * 3);
  const vdv = new DataView(vertexBytes.buffer, vertexBytes.byteOffset, vertexBytes.byteLength);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const base = i * stride + posOffset;
    // Unity → Three: flip X (left-handed → right-handed). The triangle
    // winding reversal below keeps the faces facing the right way.
    const x = -vdv.getFloat32(base, true);
    const y = vdv.getFloat32(base + 4, true);
    const z = vdv.getFloat32(base + 8, true);
    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  // Index buffer. IndexFormat 0 = uint16, 1 = uint32.
  const indexFormat = num(body['m_IndexFormat'], 0);
  const indexBufRaw = body['m_IndexBuffer'];
  if (typeof indexBufRaw !== 'string' || indexBufRaw.length === 0) return undefined;
  const ibBytes = hexToBytes(indexBufRaw);
  const indexStride = indexFormat === 0 ? 2 : 4;
  const indexCount = Math.floor(ibBytes.length / indexStride);
  if (indexCount === 0) return undefined;

  const idv = new DataView(ibBytes.buffer, ibBytes.byteOffset, ibBytes.byteLength);
  // Three.js' BufferGeometry.setIndex takes a typed array; we always output
  // uint32 so the client doesn't need to switch on format.
  const indices = new Uint32Array(indexCount);
  if (indexFormat === 0) {
    for (let i = 0; i < indexCount; i += 1) indices[i] = idv.getUint16(i * 2, true);
  } else {
    for (let i = 0; i < indexCount; i += 1) indices[i] = idv.getUint32(i * 4, true);
  }

  // Reverse triangle winding to compensate for the X-mirror above. Without
  // this the front faces would point away from the default camera and get
  // back-face-culled (rendering as invisible holes).
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tmp = indices[i + 1];
    indices[i + 1] = indices[i + 2];
    indices[i + 2] = tmp;
  }

  const positionsB64 = Buffer.from(
    positions.buffer,
    positions.byteOffset,
    positions.byteLength,
  ).toString('base64');
  const indicesB64 = Buffer.from(
    indices.buffer,
    indices.byteOffset,
    indices.byteLength,
  ).toString('base64');

  return {
    positionsB64,
    indicesB64,
    vertexCount,
    indexCount,
    aabb:
      Number.isFinite(minX) && Number.isFinite(maxX)
        ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
        : undefined,
  };
}

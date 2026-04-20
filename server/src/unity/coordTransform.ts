export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/**
 * Convert a Unity position (left-handed, Y-up) to a Three.js position
 * (right-handed, Y-up) by flipping the X axis.
 */
export function unityPositionToThree(p: { x?: number; y?: number; z?: number } | undefined): Vec3 {
  const x = -(p?.x ?? 0);
  const y = p?.y ?? 0;
  const z = p?.z ?? 0;
  return [x, y, z];
}

export function unityScaleToThree(s: { x?: number; y?: number; z?: number } | undefined): Vec3 {
  return [s?.x ?? 1, s?.y ?? 1, s?.z ?? 1];
}

/**
 * Unity serializes local rotation as a quaternion (x, y, z, w).
 * The handedness change flips rotation around Y and Z axes: (x, -y, -z, w).
 */
export function unityQuaternionToThree(
  q: { x?: number; y?: number; z?: number; w?: number } | undefined,
): Quat {
  const x = q?.x ?? 0;
  const y = q?.y ?? 0;
  const z = q?.z ?? 0;
  const w = q?.w ?? 1;
  return [x, -y, -z, w];
}

/**
 * Convert a Unity euler (degrees) to Three.js euler (radians), applying the
 * same handedness flip as the quaternion conversion.
 *
 * Unity's m_LocalEulerAnglesHint is only a hint; prefer m_LocalRotation
 * quaternion when available.
 */
export function unityEulerDegToThreeRad(
  e: { x?: number; y?: number; z?: number } | undefined,
): Vec3 {
  const DEG2RAD = Math.PI / 180;
  const x = (e?.x ?? 0) * DEG2RAD;
  const y = -(e?.y ?? 0) * DEG2RAD;
  const z = -(e?.z ?? 0) * DEG2RAD;
  return [x, y, z];
}

/** Unity color (0..1 float r/g/b/a) to plain tuple; default to white opaque. */
export function unityColorToRgba(
  c: { r?: number; g?: number; b?: number; a?: number } | undefined,
): [number, number, number, number] {
  return [c?.r ?? 1, c?.g ?? 1, c?.b ?? 1, c?.a ?? 1];
}

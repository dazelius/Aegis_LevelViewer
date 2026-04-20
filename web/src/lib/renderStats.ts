import type { GameObjectNode } from './api';

/**
 * Hard cap on the number of dynamic scene lights we forward to Three.js.
 * WebGL fragment shaders have a strict upper bound on samplers/uniforms;
 * real Unity scenes routinely contain dozens of point lights which blows
 * past that limit and produces a VALIDATE_STATUS false "Fragment shader
 * is not compiled" error with a completely blank canvas.
 */
export const MAX_DYNAMIC_LIGHTS = 4;

export interface RenderStats {
  lightCount: number;
  droppedLights: number;
}

function countAllLights(nodes: GameObjectNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.light) n += 1;
    n += countAllLights(node.children);
  }
  return n;
}

export function getRenderStats(roots: GameObjectNode[]): RenderStats {
  const total = countAllLights(roots);
  return {
    lightCount: Math.min(total, MAX_DYNAMIC_LIGHTS),
    droppedLights: Math.max(0, total - MAX_DYNAMIC_LIGHTS),
  };
}

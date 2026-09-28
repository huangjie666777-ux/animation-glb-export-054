import { Matrix4, Vector3 } from 'three';
import type { SkinInfluence, Vec3 } from './types.js';
import type { Skeleton } from './skeleton.js';
import { skinVertices } from './skinning.js';
import { rigidCharacterInverse } from './world-ik.js';

/**
 * CPU 线性混合蒙皮并把结果变换到世界空间。
 *
 * 先在角色空间做蒙皮（world*inverseBind），再对每个顶点施加一次角色矩阵；
 * 不会把角色世界矩阵重复乘入骨骼矩阵。角色矩阵仅允许单位缩放。
 * 不修改任何输入。
 */
export function skinVerticesToWorld(
  skeleton: Skeleton,
  vertices: readonly Vec3[],
  weights: readonly (readonly SkinInfluence[])[],
  boneMatrices: ReadonlyMap<string, Matrix4>,
  characterMatrix: Matrix4,
): Vec3[] {
  rigidCharacterInverse(characterMatrix); // 仅做单位缩放校验
  const skinned = skinVertices(skeleton, vertices, weights, boneMatrices);
  return skinned.map((v) => {
    const p = new Vector3(v[0], v[1], v[2]).applyMatrix4(characterMatrix);
    return [p.x, p.y, p.z];
  });
}

import { Matrix4, Vector3 } from 'three';
import type { SkinInfluence, Vec3 } from './types.js';
import type { Skeleton } from './skeleton.js';

const MAX_INFLUENCES = 4;

/**
 * CPU 线性混合蒙皮。
 *
 * - vertices 为绑定姿态下角色局部空间顶点；
 * - weights[v] 为顶点 v 的骨骼权重（至多 4 个，非负，允许总和不为 1，内部归一化）；
 * - worldMatrices 为当前姿态的骨骼世界矩阵（通常来自 evaluatePose）。
 *
 * 返回角色局部空间的新顶点数组；不修改任何输入。
 * 零总权重的顶点保持原位置。
 */
export function skinVertices(
  skeleton: Skeleton,
  vertices: readonly Vec3[],
  weights: readonly (readonly SkinInfluence[])[],
  worldMatrices: ReadonlyMap<string, Matrix4>,
): Vec3[] {
  if (vertices.length !== weights.length) {
    throw new Error('顶点数与权重数不一致: ' + vertices.length + ' vs ' + weights.length);
  }
  // 预取每骨骼蒙皮矩阵 world * inverseBind，未知骨骼在此统一拒绝。
  const skinMatrices = new Map<string, Matrix4>();
  const skinMatrixFor = (boneId: string): Matrix4 => {
    let m = skinMatrices.get(boneId);
    if (!m) {
      if (!skeleton.hasBone(boneId)) throw new Error('蒙皮权重引用了未知骨骼: ' + boneId);
      const world = worldMatrices.get(boneId);
      if (!world) throw new Error('缺少骨骼世界矩阵: ' + boneId);
      m = new Matrix4().multiplyMatrices(world, skeleton.inverseBindMatrix(boneId));
      skinMatrices.set(boneId, m);
    }
    return m;
  };

  const out = new Array<Vec3>(vertices.length);
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    if (!v.every(Number.isFinite)) throw new Error('顶点 ' + i + ' 含非法数值');
    const influences = weights[i];
    if (influences.length > MAX_INFLUENCES) {
      throw new Error('顶点 ' + i + ' 的骨骼影响数超过 ' + MAX_INFLUENCES);
    }
    let total = 0;
    for (const inf of influences) {
      if (!Number.isFinite(inf.weight) || inf.weight < 0) {
        throw new Error('顶点 ' + i + ' 存在非法权重: ' + String(inf.weight));
      }
      total += inf.weight;
    }
    if (total === 0) {
      out[i] = [v[0], v[1], v[2]];
      continue;
    }
    const acc = new Vector3();
    const tmp = new Vector3();
    for (const inf of influences) {
      if (inf.weight === 0) continue;
      const m = skinMatrixFor(inf.boneId);
      tmp.set(v[0], v[1], v[2]).applyMatrix4(m);
      acc.addScaledVector(tmp, inf.weight / total);
    }
    out[i] = [acc.x, acc.y, acc.z];
  }
  return out;
}

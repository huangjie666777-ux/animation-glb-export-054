import type { SkinMesh } from './types.js';
import type { Skeleton } from './skeleton.js';

const MAX_INFLUENCES = 4;

/** 规范化后的每顶点皮肤数据：关节顺序与骨架关节表一致，权重已归一化。 */
export interface PackedSkinVertex {
  /** 至多 4 个关节在关节表中的序号（不足补 0）。 */
  readonly joints: readonly [number, number, number, number];
  /** 与 joints 对齐的归一化权重（不足补 0）。 */
  readonly weights: readonly [number, number, number, number];
}

export interface PackedSkinMesh {
  readonly vertexCount: number;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly joints: Uint16Array;
  readonly weights: Float32Array;
  /** 位置访问器 min/max（角色空间包围盒）。 */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly vertices: PackedSkinVertex[];
}

/**
 * 校验并打包绑定姿态三角网格的皮肤数据。
 *
 * - 顶点/索引/权重数量与索引范围逐一校验，拒绝非有限值与越界索引；
 * - 每顶点至多 4 项影响，拒绝未知骨骼、负权重与零总权重；
 * - 权重按总和归一化（归一化等价于库内 skinVertices 的运行时行为）；
 * - 关节序号按给定关节表解析；全部输出写入新建类型化数组，不修改输入。
 */
export function packSkinMesh(
  skeleton: Skeleton,
  mesh: SkinMesh,
  jointIndexOf: ReadonlyMap<string, number>,
): PackedSkinMesh {
  if (!mesh || typeof mesh !== 'object') throw new Error('GLB 导出缺少网格');
  const { vertices, indices, weights } = mesh;
  if (!Array.isArray(vertices) || vertices.length === 0) {
    throw new Error('GLB 导出网格至少需要一个顶点');
  }
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error('GLB 导出网格至少需要一个三角形');
  }
  if (indices.length % 3 !== 0) {
    throw new Error('三角索引长度必须是 3 的倍数，实际为 ' + indices.length);
  }
  if (!Array.isArray(weights) || weights.length !== vertices.length) {
    throw new Error('每顶点权重数必须与顶点数一致: ' + vertices.length);
  }

  const positions = new Float32Array(vertices.length * 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    if (!Array.isArray(v) || v.length !== 3) {
      throw new Error('顶点 ' + i + ' 必须是三维数组');
    }
    for (let c = 0; c < 3; c++) {
      const n = v[c];
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new Error('顶点 ' + i + ' 含非法数值: ' + String(n));
      }
      positions[i * 3 + c] = n;
      if (n < min[c]) min[c] = n;
      if (n > max[c]) max[c] = n;
    }
  }

  const packedIndices = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (!Number.isInteger(idx) || idx < 0 || idx >= vertices.length) {
      throw new Error(
        '三角索引 ' + i + ' 越界: ' + String(idx) + '（顶点数 ' + vertices.length + '）',
      );
    }
    packedIndices[i] = idx;
  }

  const joints = new Uint16Array(vertices.length * 4);
  const packedWeights = new Float32Array(vertices.length * 4);
  const packed: PackedSkinVertex[] = [];
  for (let v = 0; v < vertices.length; v++) {
    const influences = weights[v];
    if (!Array.isArray(influences) || influences.length === 0) {
      throw new Error('顶点 ' + v + ' 缺少骨骼权重');
    }
    if (influences.length > MAX_INFLUENCES) {
      throw new Error('顶点 ' + v + ' 的骨骼影响数超过 ' + MAX_INFLUENCES);
    }
    let total = 0;
    for (const inf of influences) {
      if (!inf || typeof inf.boneId !== 'string') {
        throw new Error('顶点 ' + v + ' 存在非法骨骼影响条目');
      }
      if (!skeleton.hasBone(inf.boneId)) {
        throw new Error('顶点 ' + v + ' 引用了未知骨骼: ' + inf.boneId);
      }
      if (typeof inf.weight !== 'number' || !Number.isFinite(inf.weight) || inf.weight < 0) {
        throw new Error('顶点 ' + v + ' 存在非法权重: ' + String(inf.weight));
      }
      total += inf.weight;
    }
    if (!(total > 0)) {
      throw new Error('顶点 ' + v + ' 权重总和必须为正（不允许零总权重）');
    }
    const j: [number, number, number, number] = [0, 0, 0, 0];
    const w: [number, number, number, number] = [0, 0, 0, 0];
    for (let k = 0; k < influences.length; k++) {
      const inf = influences[k];
      const joint = jointIndexOf.get(inf.boneId);
      if (joint === undefined) throw new Error('顶点 ' + v + ' 引用了不在关节表中的骨骼: ' + inf.boneId);
      j[k] = joint;
      w[k] = inf.weight / total;
    }
    for (let k = 0; k < 4; k++) {
      joints[v * 4 + k] = j[k];
      packedWeights[v * 4 + k] = w[k];
    }
    packed.push({ joints: j, weights: w });
  }

  return {
    vertexCount: vertices.length,
    positions,
    indices: packedIndices,
    joints,
    weights: packedWeights,
    min,
    max,
       vertices: packed,
  };
}

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { BoneSpec, LocalTransform, Quat, Vec3 } from './types.js';

const QUAT_TOLERANCE = 1e-3;

function assertFinite(values: readonly number[], what: string): void {
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(what + ' 含非法数值: ' + String(v));
    }
  }
}

function assertUnitQuat(q: Quat, what: string): void {
  assertFinite(q, what);
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (Math.abs(len - 1) > QUAT_TOLERANCE) {
    throw new Error(what + ' 不是单位四元数 (|q|=' + len + ')');
  }
}

function assertPositiveScale(s: Vec3, what: string): void {
  assertFinite(s, what);
  if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) {
    throw new Error(what + ' 缩放分量必须为正');
  }
}

export function composeLocalMatrix(t: Vec3, q: Quat, s: Vec3): Matrix4 {
  return new Matrix4().compose(
    new Vector3(t[0], t[1], t[2]),
    new Quaternion(q[0], q[1], q[2], q[3]),
    new Vector3(s[0], s[1], s[2]),
  );
}

/** 骨架：校验骨骼定义并预计算绑定姿态的世界矩阵与逆绑定矩阵。 */
export class Skeleton {
  readonly boneIds: readonly string[];
  readonly parentIndex: ReadonlyMap<string, string | null>;
  /** 按父先子后的求值顺序排列的骨骼 ID。 */
  readonly evalOrder: readonly string[];
  private readonly bindLocal = new Map<string, LocalTransform>();
  private readonly bindWorld = new Map<string, Matrix4>();
  private readonly inverseBind = new Map<string, Matrix4>();

  constructor(bones: readonly BoneSpec[]) {
    if (bones.length === 0) throw new Error('骨架至少包含一根骨骼');
    const ids = new Set<string>();
    const parent = new Map<string, string | null>();
    for (const b of bones) {
      if (!b.id) throw new Error('骨骼 ID 不能为空');
      if (ids.has(b.id)) throw new Error('重复骨骼 ID: ' + b.id);
      ids.add(b.id);
      parent.set(b.id, b.parentId);
      assertFinite(b.translation, '骨骼 ' + b.id + ' 平移');
      assertUnitQuat(b.rotation, '骨骼 ' + b.id + ' 旋转');
      assertPositiveScale(b.scale, '骨骼 ' + b.id + ' 缩放');
      this.bindLocal.set(b.id, {
        translation: b.translation,
        rotation: b.rotation,
        scale: b.scale,
      });
    }
    for (const [id, p] of parent) {
      if (p !== null && !ids.has(p)) {
        throw new Error('骨骼 ' + id + ' 引用了未知父级: ' + p);
      }
    }
    // 拓扑排序 + 循环检测（三色 DFS，输入允许乱序）。
    const state = new Map<string, number>(); // 0=未访问 1=访问中 2=完成
    const order: string[] = [];
    const visit = (id: string): void => {
      const s = state.get(id) ?? 0;
      if (s === 1) throw new Error('骨骼层级存在循环，涉及: ' + id);
      if (s === 2) return;
      state.set(id, 1);
      const p = parent.get(id)!;
      if (p !== null) visit(p);
      state.set(id, 2);
      order.push(id);
    };
    for (const id of ids) visit(id);

    this.boneIds = [...ids];
    this.parentIndex = parent;
    this.evalOrder = order;

    for (const id of order) {
      const local = this.bindLocal.get(id)!;
      const m = composeLocalMatrix(local.translation, local.rotation, local.scale);
      const p = parent.get(id)!;
      const world = p === null ? m : new Matrix4().multiplyMatrices(this.bindWorld.get(p)!, m);
      this.bindWorld.set(id, world);
      this.inverseBind.set(id, world.clone().invert());
    }
  }

  /** 绑定姿态的局部变换。 */
  bindLocalTransform(id: string): LocalTransform {
    const t = this.bindLocal.get(id);
    if (!t) throw new Error('未知骨骼: ' + id);
    return t;
  }

  /** 绑定姿态的世界矩阵（只读副本语义，请勿修改返回值）。 */
  bindWorldMatrix(id: string): Matrix4 {
    const m = this.bindWorld.get(id);
    if (!m) throw new Error('未知骨骼: ' + id);
    return m;
  }

  /** 逆绑定矩阵。 */
  inverseBindMatrix(id: string): Matrix4 {
    const m = this.inverseBind.get(id);
    if (!m) throw new Error('未知骨骼: ' + id);
    return m;
  }

  hasBone(id: string): boolean {
    return this.bindLocal.has(id);
  }
}

/** 由局部姿态按父级累乘计算世界矩阵。返回 id -> Matrix4。 */
export function computeWorldMatrices(
  skeleton: Skeleton,
  localPose: ReadonlyMap<string, LocalTransform>,
): Map<string, Matrix4> {
  const world = new Map<string, Matrix4>();
  for (const id of skeleton.evalOrder) {
    const local = localPose.get(id) ?? skeleton.bindLocalTransform(id);
    const m = composeLocalMatrix(local.translation, local.rotation, local.scale);
    const p = skeleton.parentIndex.get(id)!;
    world.set(id, p === null ? m : new Matrix4().multiplyMatrices(world.get(p)!, m));
  }
  return world;
}

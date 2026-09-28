import { Quaternion, Vector3 } from 'three';
import type { RetargetBoneMapping, RetargetPlanOptions } from './types.js';
import type { Skeleton } from './skeleton.js';

const UNIT_SCALE_TOLERANCE = 1e-6;

function uniqueRootId(skeleton: Skeleton, what: string): string {
  const roots = skeleton.boneIds.filter((id) => skeleton.parentIndex.get(id) === null);
  if (roots.length !== 1) {
    throw new Error(what + '必须是单根骨架，当前顶层骨数量: ' + roots.length);
  }
  return roots[0];
}

function assertUnitBindScale(skeleton: Skeleton, what: string): void {
  for (const id of skeleton.boneIds) {
    const s = skeleton.bindLocalTransform(id).scale;
    if (s.some((v) => Math.abs(v - 1) > UNIT_SCALE_TOLERANCE)) {
      throw new Error(what + '绑定缩放必须为单位值，骨骼 ' + id + ' 非单位缩放');
    }
  }
}

/** 是否为 ancestor 的后代（含自身）。 */
function isDescendant(skeleton: Skeleton, id: string, ancestor: string): boolean {
  let cur: string | null = id;
  while (cur !== null) {
    if (cur === ancestor) return true;
    cur = skeleton.parentIndex.get(cur)!;
  }
  return false;
}

/** 取绑定世界矩阵的旋转分量（单位四元数）。 */
export function bindWorldRotation(skeleton: Skeleton, id: string): Quaternion {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  skeleton.bindWorldMatrix(id).decompose(p, q, s);
  return q;
}

/**
 * 动作重定向可复用计划。
 *
 * 校验源/目标骨架均为单根、绑定单位缩放，映射一一对应且包含双方根、
 * 保持祖先/后代次序（目标可在映射骨之间插入未映射中间骨）。预计算两侧
 * 映射骨的绑定全局旋转，供姿态转换与片段烘焙重复使用。构造与使用过程中
 * 均不改写任何输入。
 */
export class RetargetPlan {
  readonly source: Skeleton;
  readonly target: Skeleton;
  readonly sourceRootId: string;
  readonly targetRootId: string;
  /** 按目标骨架求值顺序排列的 (源骨, 目标骨) 映射。 */
  readonly mappings: readonly RetargetBoneMapping[];
  private readonly sourceToTarget = new Map<string, string>();
  private readonly targetToSource = new Map<string, string>();
  private readonly sourceBindWorldRot = new Map<string, Quaternion>();
  private readonly targetBindWorldRot = new Map<string, Quaternion>();

  constructor(options: RetargetPlanOptions) {
    if (!options || !options.source || !options.target) {
      throw new Error('重定向计划缺少源或目标骨架');
    }
    const { source, target } = options;
    const mapping = options.mapping;
    if (!Array.isArray(mapping) || mapping.length === 0) {
      throw new Error('重定向映射不能为空');
    }
    this.sourceRootId = uniqueRootId(source, '源骨架');
    this.targetRootId = uniqueRootId(target, '目标骨架');
    assertUnitBindScale(source, '源骨架');
    assertUnitBindScale(target, '目标骨架');

    for (const entry of mapping) {
      if (!entry || typeof entry.sourceBoneId !== 'string' || typeof entry.targetBoneId !== 'string') {
        throw new Error('重定向映射条目非法: ' + String(entry));
      }
      const { sourceBoneId: s, targetBoneId: t } = entry;
      if (!source.hasBone(s)) throw new Error('映射引用了未知源骨骼: ' + s);
      if (!target.hasBone(t)) throw new Error('映射引用了未知目标骨骼: ' + t);
      if (this.sourceToTarget.has(s)) throw new Error('源骨骼被重复映射: ' + s);
      if (this.targetToSource.has(t)) throw new Error('目标骨骼被重复映射: ' + t);
      this.sourceToTarget.set(s, t);
      this.targetToSource.set(t, s);
    }
    const rootTarget = this.sourceToTarget.get(this.sourceRootId);
    if (rootTarget !== this.targetRootId) {
      throw new Error(
        '重定向必须映射双方顶层根: 源根 ' + this.sourceRootId + ' -> 目标根 ' + this.targetRootId,
      );
    }

    // 保持祖先/后代次序：源侧祖先映射到目标侧后仍必须是祖先。
    for (const a of mapping) {
      for (const b of mapping) {
        if (a.sourceBoneId === b.sourceBoneId) continue;
        if (isDescendant(source, b.sourceBoneId, a.sourceBoneId)
          && !isDescendant(target, this.sourceToTarget.get(b.sourceBoneId)!, a.targetBoneId)) {
          throw new Error(
            '重定向映射必须保持骨层级次序: ' + a.sourceBoneId + '/' + b.sourceBoneId,
          );
        }
      }
    }

    this.source = source;
    this.target = target;
    const ordered: RetargetBoneMapping[] = [];
    for (const id of target.evalOrder) {
      const s = this.targetToSource.get(id);
      if (s !== undefined) ordered.push({ sourceBoneId: s, targetBoneId: id });
    }
    this.mappings = ordered;

    for (const { sourceBoneId: s, targetBoneId: t } of ordered) {
      this.sourceBindWorldRot.set(s, bindWorldRotation(source, s));
      this.targetBindWorldRot.set(t, bindWorldRotation(target, t));
    }
  }

  /** 源骨是否在映射中。 */
  hasSourceBone(id: string): boolean {
    return this.sourceToTarget.has(id);
  }

  /** 返回源骨对应的目标骨 ID，未映射返回 undefined。 */
  targetBoneIdOf(sourceBoneId: string): string | undefined {
    return this.sourceToTarget.get(sourceBoneId);
  }

  /** 返回目标骨对应的源骨 ID，未映射返回 undefined。 */
  sourceBoneIdOf(targetBoneId: string): string | undefined {
    return this.targetToSource.get(targetBoneId);
  }

  /** 源映射骨的绑定全局旋转（内部对象，请勿修改）。 */
  sourceBindRotation(id: string): Quaternion {
    const q = this.sourceBindWorldRot.get(id);
    if (!q) throw new Error('未映射的源骨骼: ' + id);
    return q;
  }

  /** 目标映射骨的绑定全局旋转（内部对象，请勿修改）。 */
  targetBindRotation(id: string): Quaternion {
    const q = this.targetBindWorldRot.get(id);
    if (!q) throw new Error('未映射的目标骨骼: ' + id);
    return q;
  }
}

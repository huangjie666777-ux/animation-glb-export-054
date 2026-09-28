import { Matrix4, Quaternion, Vector3 } from 'three';
import type { LocalTransform, Quat, Vec3 } from './types.js';
import type { RetargetPlan } from './retarget-plan.js';
import { computeWorldMatrices } from './skeleton.js';

const QUAT_TOLERANCE = 1e-3;

function assertFiniteVec(v: Vec3, what: string): void {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(what + ' 必须是三个有限数');
  }
}

function assertUnitQuat(q: Quat, what: string): void {
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) {
    throw new Error(what + ' 旋转含非法数值');
  }
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (Math.abs(len - 1) > QUAT_TOLERANCE) throw new Error(what + ' 旋转不是单位四元数');
}

function assertPositiveScale(s: Vec3, what: string): void {
  if (!Array.isArray(s) || s.length !== 3 || !s.every(Number.isFinite)) {
    throw new Error(what + ' 缩放含非法数值');
  }
  if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) throw new Error(what + ' 缩放分量必须为正');
}

function assertCompletePose(
  plan: RetargetPlan,
  sourcePose: ReadonlyMap<string, LocalTransform>,
): void {
  if (sourcePose.size !== plan.source.boneIds.length) {
    throw new Error('重定向需要源骨架的完整局部姿态: 缺少骨骼或包含多余姿态');
  }
  for (const id of plan.source.boneIds) {
    const t = sourcePose.get(id);
    if (!t) throw new Error('源局部姿态缺少骨骼: ' + id);
    assertFiniteVec(t.translation, '骨骼 ' + id + ' 平移');
    assertUnitQuat(t.rotation, '骨骼 ' + id);
    assertPositiveScale(t.scale, '骨骼 ' + id);
  }
}

function worldRotationOf(m: Matrix4): Quaternion {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return q;
}

/**
 * 把完整源局部姿态转换为完整目标局部姿态。
 *
 * - 映射骨：旋转差 = 当前源全局旋转 × 源绑定全局旋转⁻¹；目标全局旋转 =
 *   旋转差 × 目标绑定全局旋转；再按目标当前父全局旋转还原局部旋转。
 * - 未映射骨：保留目标绑定局部旋转（自动继承父级运动）。
 * - 非根平移/缩放：保留目标绑定值（目标骨长不变）。
 * - 根平移：目标绑定位置 +（源当前根位置 − 源绑定根位置）×倍率；
 *   根旋转同样按映射规则转换；根缩放保留目标绑定值。
 *
 * 源绑定姿态必定映成目标绑定姿态。返回全新 Map，后续转换不会改写先前结果。
 */
export function retargetPose(
  plan: RetargetPlan,
  sourcePose: ReadonlyMap<string, LocalTransform>,
  rootTranslationScale = 1,
): Map<string, LocalTransform> {
  if (typeof rootTranslationScale !== 'number' || !Number.isFinite(rootTranslationScale) || rootTranslationScale <= 0) {
    throw new Error('根位移倍率必须为有限正数: ' + String(rootTranslationScale));
  }
  assertCompletePose(plan, sourcePose);

  const { source, target } = plan;
  // 复制一份输入姿态再累乘世界矩阵，保证绝不改写调用方的 Map 与其中数组。
  const sourceCopy = new Map<string, LocalTransform>();
  for (const id of source.boneIds) {
    const t = sourcePose.get(id)!;
    sourceCopy.set(id, {
      translation: [t.translation[0], t.translation[1], t.translation[2]],
      rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
      scale: [t.scale[0], t.scale[1], t.scale[2]],
    });
  }
  const sourceWorld = computeWorldMatrices(source, sourceCopy);

  const out = new Map<string, LocalTransform>();
  for (const id of target.evalOrder) {
    const bind = target.bindLocalTransform(id);
    out.set(id, {
      translation: [bind.translation[0], bind.translation[1], bind.translation[2]],
      rotation: [bind.rotation[0], bind.rotation[1], bind.rotation[2], bind.rotation[3]],
      scale: [bind.scale[0], bind.scale[1], bind.scale[2]],
    });
  }

  // 根平移：源根（全局=局部）相对绑定位置的位移乘倍率，加到目标绑定根位置。
  const sourceRootCurrent = sourceCopy.get(plan.sourceRootId)!;
  const sourceRootBind = source.bindLocalTransform(plan.sourceRootId);
  const targetRootBind = target.bindLocalTransform(plan.targetRootId);
  const rootOut = out.get(plan.targetRootId)!;
  out.set(plan.targetRootId, {
    ...rootOut,
    translation: [
      targetRootBind.translation[0]
        + (sourceRootCurrent.translation[0] - sourceRootBind.translation[0]) * rootTranslationScale,
      targetRootBind.translation[1]
        + (sourceRootCurrent.translation[1] - sourceRootBind.translation[1]) * rootTranslationScale,
      targetRootBind.translation[2]
        + (sourceRootCurrent.translation[2] - sourceRootBind.translation[2]) * rootTranslationScale,
    ],
  });

  // 按目标求值顺序递推每根骨的当前全局旋转：映射骨写入目标全局旋转，
  // 未映射骨保持绑定局部旋转并继承已运动的父级（允许目标插入中间骨）。
  const targetWorldRot = new Map<string, Quaternion>();
  const mappedTargets = new Set(plan.mappings.map((m) => m.targetBoneId));
  const targetRootId = plan.targetRootId;
  for (const id of target.evalOrder) {
    const parent = target.parentIndex.get(id)!;
    const parentWorldRot = parent === null ? new Quaternion() : targetWorldRot.get(parent)!;
    let localRot: Quaternion;
    if (mappedTargets.has(id)) {
      const sourceBoneId = plan.sourceBoneIdOf(id)!;
      const sourceCurrentWorldRot = worldRotationOf(sourceWorld.get(sourceBoneId)!);
      const delta = new Quaternion().multiplyQuaternions(
        sourceCurrentWorldRot,
        plan.sourceBindRotation(sourceBoneId).clone().invert(),
      );
      const targetWorld = new Quaternion().multiplyQuaternions(delta, plan.targetBindRotation(id));
      targetWorldRot.set(id, targetWorld);
      localRot = targetWorld.clone().premultiply(parentWorldRot.clone().invert()).normalize();
    } else {
      localRot = new Quaternion(...out.get(id)!.rotation);
      targetWorldRot.set(id, parentWorldRot.clone().multiply(localRot));
    }
    const rootTranslation = id === targetRootId ? out.get(id)!.translation : undefined;
    out.set(id, {
      translation: rootTranslation ?? out.get(id)!.translation,
      rotation: [localRot.x, localRot.y, localRot.z, localRot.w] as Quat,
      scale: out.get(id)!.scale,
    });
  }

  return out;
}

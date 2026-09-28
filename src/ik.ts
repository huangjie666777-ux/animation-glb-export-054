import { Matrix4, Quaternion, Vector3 } from 'three';
import type { LocalTransform, Quat, TwoBoneIkRequest, TwoBoneIkResult, Vec3 } from './types.js';
import { computeWorldMatrices, Skeleton } from './skeleton.js';
import { slerpQuat } from './pose.js';

const QUAT_TOLERANCE = 1e-3;
const UNIT_SCALE_TOLERANCE = 1e-6;
const AXIS_EPSILON = 1e-10;

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
  if (Math.abs(len - 1) > QUAT_TOLERANCE) {
    throw new Error(what + ' 旋转不是单位四元数');
  }
}

function assertPoseTransform(t: LocalTransform | undefined, id: string): asserts t is LocalTransform {
  if (!t) throw new Error('局部姿态缺少骨骼: ' + id);
  assertFiniteVec(t.translation, '骨骼 ' + id + ' 平移');
  assertUnitQuat(t.rotation, '骨骼 ' + id);
  if (!Array.isArray(t.scale) || t.scale.length !== 3 || !t.scale.every(Number.isFinite)) {
    throw new Error('骨骼 ' + id + ' 缩放含非法数值');
  }
  if (t.scale[0] <= 0 || t.scale[1] <= 0 || t.scale[2] <= 0) {
    throw new Error('骨骼 ' + id + ' 缩放分量必须为正');
  }
}

function assertUnitScale(t: LocalTransform, id: string): void {
  for (const s of t.scale) {
    if (Math.abs(s - 1) > UNIT_SCALE_TOLERANCE) {
      throw new Error('IK 链及其祖先仅支持单位缩放，骨骼 ' + id + ' 缩放非单位');
    }
  }
}

function worldPosition(m: Matrix4): Vector3 {
  return new Vector3(m.elements[12], m.elements[13], m.elements[14]);
}

function worldRotation(m: Matrix4): Quaternion {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return q;
}

function stablePerpendicular(dir: Vector3): Vector3 {
  const reference = Math.abs(dir.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  return new Vector3().crossVectors(dir, reference).normalize();
}

function perpendicularContribution(from: Vector3, point: Vector3, dir: Vector3): Vector3 | null {
  const v = point.clone().sub(from);
  v.addScaledVector(dir, -v.dot(dir));
  const len = v.length();
  return len < AXIS_EPSILON ? null : v.divideScalar(len);
}

function toVec3(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

/**
 * 对直接相连的 root-middle-end 三骨骼链执行两骨骼 IK。
 *
 * 输入局部姿态不会被修改；返回新的完整局部姿态与世界矩阵。仅 root/middle
 * 的局部旋转允许改变，平移、缩放、末端及其余骨骼局部姿态均保持不变。
 */
export function solveTwoBoneIk(
  skeleton: Skeleton,
  localPose: ReadonlyMap<string, LocalTransform>,
  request: TwoBoneIkRequest,
): TwoBoneIkResult {
  const { rootJointId: rootId, middleJointId: middleId, endJointId: endId } = request;
  for (const id of [rootId, middleId, endId]) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('IK 骨骼 ID 不能为空');
    if (!skeleton.hasBone(id)) throw new Error('IK 引用了未知骨骼: ' + id);
  }
  if (new Set([rootId, middleId, endId]).size !== 3) {
    throw new Error('IK 链的三个骨骼 ID 必须互不相同');
  }
  if (skeleton.parentIndex.get(middleId) !== rootId) {
    throw new Error('IK 中间骨骼必须是根骨骼的直接子级');
  }
  if (skeleton.parentIndex.get(endId) !== middleId) {
    throw new Error('IK 末端骨骼必须是中间骨骼的直接子级');
  }
  assertFiniteVec(request.target, 'IK 目标点');
  assertFiniteVec(request.bendReference, 'IK 弯曲参考点');
  if (!Number.isFinite(request.weight) || request.weight < 0 || request.weight > 1) {
    throw new Error('IK 权重必须在 [0, 1]: ' + String(request.weight));
  }
  if (localPose.size !== skeleton.boneIds.length) {
    throw new Error('IK 需要完整局部姿态: 缺少骨骼或包含多余姿态');
  }
  for (const id of skeleton.boneIds) {
    assertPoseTransform(localPose.get(id), id);
  }

  const unitScaleIds = new Set<string>([rootId, middleId, endId]);
  let ancestor = skeleton.parentIndex.get(rootId);
  while (ancestor !== null) {
    if (!ancestor) break;
    unitScaleIds.add(ancestor);
    ancestor = skeleton.parentIndex.get(ancestor) ?? null;
  }
  for (const id of unitScaleIds) assertUnitScale(localPose.get(id)!, id);

  const middleLocal = localPose.get(middleId)!;
  const endLocal = localPose.get(endId)!;
  const length1 = Math.hypot(...middleLocal.translation);
  const length2 = Math.hypot(...endLocal.translation);
  if (!(length1 > 0)) throw new Error('IK 根到中间关节的骨段长度必须非零');
  if (!(length2 > 0)) throw new Error('IK 中间关节到末端的骨段长度必须非零');

  const inputWorld = computeWorldMatrices(skeleton, localPose);
  const rootPos = worldPosition(inputWorld.get(rootId)!);
  const middlePos = worldPosition(inputWorld.get(middleId)!);
  const endPos = worldPosition(inputWorld.get(endId)!);
  const target = new Vector3(...request.target);
  const bend = new Vector3(...request.bendReference);

  const rawDistance = target.distanceTo(rootPos);
  const targetOnRoot = rawDistance < AXIS_EPSILON;
  const rootToEnd = endPos.clone().sub(rootPos);
  const rootToMiddle = middlePos.clone().sub(rootPos);
  let endDir = target.clone().sub(rootPos);
  if (endDir.lengthSq() < AXIS_EPSILON * AXIS_EPSILON) {
    endDir = rootToEnd.lengthSq() >= AXIS_EPSILON * AXIS_EPSILON ? rootToEnd : rootToMiddle;
  }
  endDir.normalize();

  // 目标与根重合时无法由目标定义新弯曲方向，必须优先沿用当前弯曲平面：
  // 用当前中间关节相对 root->end 轴的侧向分量，忽略参考点；共线时再退化。
  let bendSide: Vector3 | null = null;
  if (targetOnRoot) {
    bendSide = perpendicularContribution(rootPos, middlePos, endDir)
      ?? perpendicularContribution(middlePos, endPos, endDir);
  } else {
    bendSide = perpendicularContribution(rootPos, bend, endDir)
      ?? perpendicularContribution(rootPos, middlePos, endDir)
      ?? perpendicularContribution(middlePos, endPos, endDir);
  }
  bendSide = bendSide ?? stablePerpendicular(endDir);
  bendSide = bendSide.normalize();

  const minReach = Math.abs(length1 - length2);
  const maxReach = length1 + length2;
  const reachable = rawDistance <= maxReach + UNIT_SCALE_TOLERANCE
    && rawDistance >= minReach - UNIT_SCALE_TOLERANCE;
  const clampedDistance = Math.min(Math.max(rawDistance, minReach), maxReach);
  const clampedTarget = rootPos.clone().addScaledVector(endDir, clampedDistance);

  const along = clampedDistance * clampedDistance + length1 * length1 - length2 * length2;
  const middleAlong = clampedDistance === 0 ? 0 : along / (2 * clampedDistance);
  const heightSq = length1 * length1 - middleAlong * middleAlong;
  const middleHeight = Math.sqrt(Math.max(0, heightSq));
  const solvedMiddle = rootPos.clone()
    .addScaledVector(endDir, clampedDistance === 0 ? 0 : middleAlong)
    .addScaledVector(bendSide, middleHeight);
  const solvedSegment1 = solvedMiddle.clone().sub(rootPos);
  const solvedSegment2 = clampedTarget.clone().sub(solvedMiddle);

  const currentSegment1 = middlePos.clone().sub(rootPos).normalize();
  const currentSegment2 = endPos.clone().sub(middlePos).normalize();
  solvedSegment1.normalize();
  solvedSegment2.normalize();

  const currentRootRot = worldRotation(inputWorld.get(rootId)!);
  const currentMiddleRot = worldRotation(inputWorld.get(middleId)!);
  const rootWorldDelta = new Quaternion().setFromUnitVectors(currentSegment1, solvedSegment1);
  const middleWorldDelta = new Quaternion().setFromUnitVectors(currentSegment2, solvedSegment2);
  const solvedRootWorldRot = rootWorldDelta.multiply(currentRootRot);
  const solvedMiddleWorldRot = middleWorldDelta.multiply(currentMiddleRot);

  const rootParent = skeleton.parentIndex.get(rootId);
  const rootParentWorldRot = !rootParent
    ? new Quaternion()
    : worldRotation(inputWorld.get(rootParent)!);
  const solvedRootLocalRot = rootParentWorldRot.clone().invert().multiply(solvedRootWorldRot);
  const solvedMiddleLocalRot = solvedRootWorldRot.clone().invert().multiply(solvedMiddleWorldRot);

  const resultPose = new Map<string, LocalTransform>();
  for (const [id, t] of localPose) {
    resultPose.set(id, { translation: t.translation, rotation: t.rotation, scale: t.scale });
  }
  const originalRootRot = localPose.get(rootId)!.rotation;
  const originalMiddleRot = localPose.get(middleId)!.rotation;
  const solvedRootLocal = [solvedRootLocalRot.x, solvedRootLocalRot.y, solvedRootLocalRot.z, solvedRootLocalRot.w] as Quat;
  const solvedMiddleLocal = [solvedMiddleLocalRot.x, solvedMiddleLocalRot.y, solvedMiddleLocalRot.z, solvedMiddleLocalRot.w] as Quat;
  resultPose.set(rootId, {
    ...localPose.get(rootId)!,
    rotation: request.weight === 0 ? originalRootRot : slerpQuat(originalRootRot, solvedRootLocal, request.weight),
  });
  resultPose.set(middleId, {
    ...localPose.get(middleId)!,
    rotation: request.weight === 0 ? originalMiddleRot : slerpQuat(originalMiddleRot, solvedMiddleLocal, request.weight),
  });

  const worldMatrices = computeWorldMatrices(skeleton, resultPose);
  const actualEndPosition = worldPosition(worldMatrices.get(endId)!);
  return {
    localPose: resultPose,
    worldMatrices,
    reachable,
    distanceToTarget: actualEndPosition.distanceTo(target),
    actualEndPosition: toVec3(actualEndPosition),
    clampedTarget: toVec3(clampedTarget),
  };
}

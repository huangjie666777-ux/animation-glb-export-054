import { Matrix4, Quaternion, Vector3 } from 'three';
import type {
  LocalTransform,
  TwoBoneIkChain,
  WorldTwoBoneIkRequest,
  WorldTwoBoneIkResult,
} from './types.js';
import type { Skeleton } from './skeleton.js';
import { solveTwoBoneIk } from './ik.js';

const UNIT_SCALE_TOLERANCE = 1e-6;

function assertFiniteWorldPoint(v: readonly number[], what: string): void {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(what + ' 必须是三个有限数');
  }
}

/** 校验角色矩阵仅含单位缩放（刚体），返回其逆矩阵。 */
export function rigidCharacterInverse(characterMatrix: Matrix4): Matrix4 {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  characterMatrix.decompose(p, q, s);
  for (const v of [s.x, s.y, s.z]) {
    if (Math.abs(v - 1) > UNIT_SCALE_TOLERANCE) throw new Error('角色变换仅支持单位缩放');
  }
  return characterMatrix.clone().invert();
}

function worldToCharacter(world: Vector3, inverse: Matrix4): Vector3 {
  return world.clone().applyMatrix4(inverse);
}

/**
 * 世界空间两骨骼 IK 适配。
 *
 * 将世界目标与弯曲参考点经当前角色刚体变换的逆矩阵转入角色空间，复用
 * solveTwoBoneIk；再把实际末端变换回世界空间。返回世界末端、可达性与残差。
 * 角色矩阵仅允许单位缩放；不修改输入参数。
 */
export function solveWorldTwoBoneIk(
  skeleton: Skeleton,
  localPose: ReadonlyMap<string, LocalTransform>,
  request: WorldTwoBoneIkRequest,
): WorldTwoBoneIkResult {
  if (!request || !request.characterMatrix) throw new Error('世界 IK 缺少角色变换矩阵');
  assertFiniteWorldPoint(request.worldTarget, 'IK 世界目标点');
  assertFiniteWorldPoint(request.worldBendReference, 'IK 世界弯曲参考点');
  const inverse = rigidCharacterInverse(request.characterMatrix);
  const characterTarget = worldToCharacter(new Vector3(...request.worldTarget), inverse);
  const characterBend = worldToCharacter(new Vector3(...request.worldBendReference), inverse);

  const chain: TwoBoneIkChain = {
    rootJointId: request.rootJointId,
    middleJointId: request.middleJointId,
    endJointId: request.endJointId,
  };
  const solved = solveTwoBoneIk(skeleton, localPose, {
    ...chain,
    target: [characterTarget.x, characterTarget.y, characterTarget.z],
    bendReference: [characterBend.x, characterBend.y, characterBend.z],
    weight: request.weight,
  });

  const worldEnd = new Vector3(...solved.actualEndPosition).applyMatrix4(request.characterMatrix);
  return {
    localPose: solved.localPose,
    worldMatrices: solved.worldMatrices,
    worldEndPosition: [worldEnd.x, worldEnd.y, worldEnd.z],
    actualEndPosition: solved.actualEndPosition,
    reachable: solved.reachable,
    distanceToTarget: worldEnd.distanceTo(new Vector3(...request.worldTarget)),
  };
}

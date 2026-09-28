import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Skeleton,
  evaluatePose,
  skinVertices,
  solveTwoBoneIk,
  type LocalTransform,
} from '../src/index.js';
import { humanoidBones, walkClip, waveClip, IDENTITY_QUAT, UNIT_SCALE } from './helpers.js';
import { Matrix4, Vector3 } from 'three';

const sk = new Skeleton(humanoidBones());
const armLength = Math.hypot(0.25, 0.15);
const handLength = 0.3;

function basePose(skeleton: Skeleton = sk): Map<string, LocalTransform> {
  return evaluatePose(
    skeleton,
    { clip: walkClip(), time: 0.3, loop: 'loop' },
    { clip: waveClip(), time: 0.5, loop: 'loop', strength: 1, mask: { 'arm.R': 1 } },
  ).localPose;
}

function worldPosition(matrices: ReadonlyMap<string, Matrix4>, id: string): Vector3 {
  const e = matrices.get(id)!.elements;
  return new Vector3(e[12], e[13], e[14]);
}

test('满权重可达目标：末端到达目标，仅根/中间关节旋转改变', () => {
  const input = basePose();
  const snapshot = JSON.stringify([...input]);
  const mixed = evaluatePose(sk, {
    clip: walkClip(), time: 0.3, loop: 'loop',
  }, {
    clip: waveClip(), time: 0.5, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  });
  const spine = worldPosition(mixed.worldMatrices, 'spine');
  const target: readonly [number, number, number] = [
    spine.x + 0.24,
    spine.y - 0.08,
    spine.z + 0.3,
  ];
  const bend: readonly [number, number, number] = [spine.x + 0.05, spine.y + 0.4, spine.z + 0.12];
  const result = solveTwoBoneIk(sk, input, {
    rootJointId: 'spine',
    middleJointId: 'arm.R',
    endJointId: 'hand.R',
    target,
    bendReference: bend,
    weight: 1,
  });

  const end = worldPosition(result.worldMatrices, 'hand.R');
  assert.ok(end.distanceTo(new Vector3(...target)) < 1e-8);
  assert.equal(result.reachable, true);
  assert.ok(result.distanceToTarget < 1e-8);
  assert.deepEqual(JSON.stringify([...input]), snapshot);
  assert.deepEqual(result.localPose.get('hand.R'), input.get('hand.R'));
  assert.deepEqual(result.localPose.get('spine')!.translation, input.get('spine')!.translation);
  assert.deepEqual(result.localPose.get('spine')!.scale, input.get('spine')!.scale);
  assert.deepEqual(result.localPose.get('arm.R')!.translation, input.get('arm.R')!.translation);
  assert.deepEqual(result.localPose.get('arm.R')!.scale, input.get('arm.R')!.scale);
  for (const id of sk.boneIds) {
    if (id !== 'spine' && id !== 'arm.R') {
      assert.deepEqual(result.localPose.get(id), input.get(id));
    }
  }

  const middle = worldPosition(result.worldMatrices, 'arm.R');
  const root = worldPosition(result.worldMatrices, 'spine');
  const axis = new Vector3(...target).sub(root).normalize();
  const side = middle.sub(root).addScaledVector(axis, -middle.clone().sub(root).dot(axis));
  const bendSide = new Vector3(...bend).sub(root).addScaledVector(axis, -new Vector3(...bend).sub(root).dot(axis));
  assert.ok(side.dot(bendSide) > 0);
});

test('过远/过近目标沿方向夹取并返回可达性和距离', () => {
  const input = basePose();
  const matrices = evaluatePose(sk, { clip: walkClip(), time: 0.3, loop: 'loop' }, {
    clip: waveClip(), time: 0.5, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  }).worldMatrices;
  const root = worldPosition(matrices, 'spine');
  const farTarget: [number, number, number] = [root.x + armLength + handLength + 0.5, root.y, root.z];
  const far = solveTwoBoneIk(sk, input, {
    rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
    target: farTarget, bendReference: [root.x, root.y + 1, root.z], weight: 1,
  });
  assert.equal(far.reachable, false);
  assert.ok(Math.abs(far.distanceToTarget - 0.5) < 1e-8);
  assert.ok(far.actualEndPosition[0] - (root.x + armLength + handLength) < 1e-8);

  const nearTarget: [number, number, number] = [root.x, root.y, root.z];
  const near = solveTwoBoneIk(sk, input, {
    rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
    target: nearTarget, bendReference: [root.x, root.y + 1, root.z], weight: 1,
  });
  assert.equal(near.reachable, false);
  const end = new Vector3(...near.actualEndPosition);
  assert.ok(Math.abs(end.distanceTo(root) - Math.abs(armLength - handLength)) < 1e-8);
  assert.ok(Math.abs(near.distanceToTarget - end.distanceTo(root)) < 1e-8);
  for (const v of near.actualEndPosition) assert.ok(Number.isFinite(v));
});

test('权重 0 保持原姿态，中间权重连续应用，重复调用稳定', () => {
  const input = basePose();
  const matrices = evaluatePose(sk, { clip: walkClip(), time: 0.3, loop: 'loop' }, {
    clip: waveClip(), time: 0.5, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  }).worldMatrices;
  const root = worldPosition(matrices, 'spine');
  const req = {
    rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
    target: [root.x + 0.2, root.y - 0.2, root.z + 0.25] as [number, number, number],
    bendReference: [root.x, root.y + 1, root.z] as [number, number, number],
  };
  const zero = solveTwoBoneIk(sk, input, { ...req, weight: 0 });
  assert.deepEqual([...zero.localPose], [...input]);
  const half = solveTwoBoneIk(sk, input, { ...req, weight: 0.5 });
  const full = solveTwoBoneIk(sk, input, { ...req, weight: 1 });
  const halfEnd = worldPosition(half.worldMatrices, 'hand.R').distanceTo(new Vector3(...req.target));
  const zeroEnd = worldPosition(zero.worldMatrices, 'hand.R').distanceTo(new Vector3(...req.target));
  assert.ok(halfEnd < zeroEnd);
  assert.ok(halfEnd > full.distanceToTarget);
  const again = solveTwoBoneIk(sk, input, { ...req, weight: 0.5 });
  assert.deepEqual(again.actualEndPosition, half.actualEndPosition);
});

test('目标与根重合时优先沿用当前弯曲平面，忽略参考点', () => {
  // 当前链 root(0,0) -> mid(1,0) -> end(1,1)；目标与根重合时
  // endDir 退化为 root->end，中间关节相对该轴的侧向为 (1,-1) 一侧。
  // 参考点故意取相反侧向 (-1,1)，修复后应被忽略。
  const bones = [
    { id: 'end', parentId: 'mid', translation: [0, 1, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const },
    { id: 'mid', parentId: 'root', translation: [1, 0, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const },
    { id: 'root', parentId: null, translation: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const },
  ];
  const chainSk = new Skeleton(bones);
  const pose = new Map<string, LocalTransform>();
  for (const id of ['root', 'mid', 'end']) pose.set(id, chainSk.bindLocalTransform(id));
  const result = solveTwoBoneIk(chainSk, pose, {
    rootJointId: 'root',
    middleJointId: 'mid',
    endJointId: 'end',
    target: [0, 0, 0],
    bendReference: [-100, 100, 0], // 与当前侧向相反，应被忽略
    weight: 1,
  });
  const midPos = worldPosition(result.worldMatrices, 'mid');
  const side = new Vector3(1, -1, 0).normalize();
  assert.ok(midPos.dot(side) > 0.99); // 中点保持在当前弯曲平面的 (1,-1) 侧向
});

test('IK 结果可直接送入 CPU 蒙皮且多角色互不污染', () => {
  const inputA = basePose();
  const inputB = basePose();
  const matricesA = evaluatePose(sk, { clip: walkClip(), time: 0.3, loop: 'loop' }, {
    clip: waveClip(), time: 0.5, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  }).worldMatrices;
  const root = worldPosition(matricesA, 'spine');
  const ikA = solveTwoBoneIk(sk, inputA, {
    rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
    target: [root.x + 0.2, root.y - 0.1, root.z + 0.35],
    bendReference: [root.x, root.y + 1, root.z], weight: 1,
  });
  const ikB = solveTwoBoneIk(sk, inputB, {
    rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
    target: [root.x - 0.1, root.y + 0.2, root.z + 0.2],
    bendReference: [root.x - 1, root.y, root.z], weight: 0.7,
  });
  const verts: [number, number, number][] = [[0.55, 1.35, 0]];
  const weights = [[{ boneId: 'hand.R', weight: 1 }]];
  const outA = skinVertices(sk, verts, weights, ikA.worldMatrices);
  const outB = skinVertices(sk, verts, weights, ikB.worldMatrices);
  assert.ok(new Vector3(...outA[0]).distanceTo(new Vector3(...outB[0])) > 0.01);
  assert.deepEqual(inputA, inputB);
});

test('拒绝非直接链、非单位缩放、零骨段和非法权重', () => {
  const input = basePose();
  assert.throws(
    () => solveTwoBoneIk(sk, input, {
      rootJointId: 'hips', middleJointId: 'arm.R', endJointId: 'hand.R',
      target: [0, 0, 0], bendReference: [0, 1, 0], weight: 1,
    }),
    /直接子级/,
  );
  assert.throws(
    () => solveTwoBoneIk(sk, input, {
      rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
      target: [0, 0, 0], bendReference: [0, 1, 0], weight: 2,
    }),
    /\[0, 1\]/,
  );
  const badScale = new Map(input);
  badScale.set('hips', { ...badScale.get('hips')!, scale: [1, 1, 2] });
  assert.throws(
    () => solveTwoBoneIk(sk, badScale, {
      rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
      target: [0, 0, 0], bendReference: [0, 1, 0], weight: 1,
    }),
    /单位缩放/,
  );

  const bones = humanoidBones().map((b) => b.id === 'hand.R'
    ? { ...b, translation: [0, 0, 0] as const }
    : b);
  const zeroBone = new Skeleton(bones);
  const zeroPose = new Map<string, LocalTransform>(
    zeroBone.boneIds.map((id) => [id, {
      translation: zeroBone.bindLocalTransform(id).translation,
      rotation: IDENTITY_QUAT,
      scale: UNIT_SCALE,
    }]),
  );
  assert.throws(
    () => solveTwoBoneIk(zeroBone, zeroPose, {
      rootJointId: 'spine', middleJointId: 'arm.R', endJointId: 'hand.R',
      target: [0, 0, 0], bendReference: [0, 1, 0], weight: 1,
    }),
    /长度必须非零/,
  );
});

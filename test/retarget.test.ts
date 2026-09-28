import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import {
  Skeleton,
  RetargetPlan,
  retargetPose,
  bakeRetargetedClip,
  RootMotionPlayer,
  sampleClip,
  computeWorldMatrices,
  type BoneSpec,
  type Quat,
  type Vec3,
} from '../src/index.js';
import {
  humanoidBones,
  quatZ,
  quatY,
  rootMotionWalkClip,
  IDENTITY_QUAT,
  UNIT_SCALE,
} from './helpers.js';

const src = new Skeleton(humanoidBones());

/**
 * 目标骨架：骨名、绑定朝向（j_armR 预转 0.2rad）、骨长均不同；
 * 在根与脊柱之间插入未映射中间骨 j_spine0。
 */
function targetBones(): BoneSpec[] {
  const bone = (
    id: string,
    parentId: string | null,
    t: Vec3,
    r: Quat = IDENTITY_QUAT,
  ): BoneSpec => ({ id, parentId, translation: t, rotation: r, scale: UNIT_SCALE });
  return [
    bone('j_hips', null, [0, 0.8, 0]),
    bone('j_spine0', 'j_hips', [0, 0.1, 0]),
    bone('j_spine', 'j_spine0', [0, 0.25, 0]),
    bone('j_head', 'j_spine', [0, 0.4, 0]),
    bone('j_armL', 'j_spine', [-0.3, 0.2, 0]),
    bone('j_handL', 'j_armL', [0, 0.4, 0]),
    bone('j_armR', 'j_spine', [0.3, 0.2, 0], quatZ(0.2)),
    bone('j_handR', 'j_armR', [0, 0.4, 0]),
    bone('j_legL', 'j_hips', [0.15, 0, 0]),
    bone('j_legR', 'j_hips', [-0.15, 0, 0]),
  ];
}

const dst = new Skeleton(targetBones());

const mapping = [
  ['hips', 'j_hips'],
  ['spine', 'j_spine'],
  ['head', 'j_head'],
  ['arm.L', 'j_armL'],
  ['hand.L', 'j_handL'],
  ['arm.R', 'j_armR'],
  ['hand.R', 'j_handR'],
  ['leg.L', 'j_legL'],
  ['leg.R', 'j_legR'],
] as const;

const plan = new RetargetPlan({
  source: src,
  target: dst,
  mapping: mapping.map(([sourceBoneId, targetBoneId]) => ({ sourceBoneId, targetBoneId })),
});

const qAngle = (a: Quat, b: Quat): number =>
  new Quaternion(...a).angleTo(new Quaternion(...b));

test('源绑定姿态映成目标绑定姿态（含未映射中间骨）', () => {
  const bindPose = new Map(src.boneIds.map((id) => [id, src.bindLocalTransform(id)]));
  const out = retargetPose(plan, bindPose);
  assert.equal(out.size, dst.boneIds.length);
  for (const id of dst.boneIds) {
    const b = dst.bindLocalTransform(id);
    const o = out.get(id)!;
    assert.deepEqual(o.translation, b.translation);
    assert.deepEqual(o.scale, b.scale);
    assert.ok(qAngle(o.rotation, b.rotation) < 1e-10, id);
  }
});

test('映射骨旋转差重定向，保留目标绑定朝向偏移与不同骨长', () => {
  const pose = sampleClip(rootMotionWalkClip(), src, 0, 'once');
  const out = retargetPose(plan, pose);
  assert.ok(qAngle(out.get('j_legL')!.rotation, quatZ(0.4)) < 1e-10);
  assert.ok(qAngle(out.get('j_armR')!.rotation, quatZ(0.2)) < 1e-10);
  assert.deepEqual(out.get('j_handR')!.translation, [0, 0.4, 0]);
  assert.deepEqual(out.get('j_spine0')!.translation, [0, 0.1, 0]);
  assert.deepEqual(out.get('j_handR')!.scale, [1, 1, 1]);
});

test('不同绑定朝向：源运动叠加在目标绑定朝向之上', () => {
  const pose = new Map(src.boneIds.map((id) => [id, src.bindLocalTransform(id)]));
  pose.set('arm.R', { ...pose.get('arm.R')!, rotation: quatZ(1.2) });
  const out = retargetPose(plan, pose);
  assert.ok(qAngle(out.get('j_armR')!.rotation, quatZ(1.4)) < 1e-10);
});

test('未映射中间骨保持绑定局部姿态并继承父运动', () => {
  const pose = new Map(src.boneIds.map((id) => [id, src.bindLocalTransform(id)]));
  pose.set('hips', { ...pose.get('hips')!, rotation: quatY(Math.PI / 2) });
  const out = retargetPose(plan, pose);
  assert.ok(qAngle(out.get('j_spine0')!.rotation, IDENTITY_QUAT) < 1e-10);
  const world = computeWorldMatrices(dst, out);
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  world.get('j_spine0')!.decompose(p, q, s);
  assert.ok(
    q.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2)) < 1e-10,
  );
});

test('根平移按倍率缩放并加在目标绑定位置上', () => {
  const pose = new Map(src.boneIds.map((id) => [id, src.bindLocalTransform(id)]));
  pose.set('hips', { ...pose.get('hips')!, translation: [0.3, 1.05, -0.2] });
  const out1 = retargetPose(plan, pose);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(out1.get('j_hips')!.translation[i] - [0.3, 0.85, -0.2][i]) < 1e-12);
  }
  const out2 = retargetPose(plan, pose, 2);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(out2.get('j_hips')!.translation[i] - [0.6, 0.9, -0.4][i]) < 1e-12);
  }
  assert.throws(() => retargetPose(plan, pose, 0), /有限正数/);
  assert.throws(() => retargetPose(plan, pose, Number.NaN), /有限正数/);
});

test('返回结果独立，不改写输入且复用计划互不干扰', () => {
  const poseA = sampleClip(rootMotionWalkClip(), src, 0.25, 'once');
  const savedSourceLeg = poseA.get('leg.L')!.rotation.slice();
  const a = retargetPose(plan, poseA);
  const savedLeg = a.get('j_legL')!.rotation.slice();
  (a.get('j_legL')!.rotation as unknown as number[])[0] = 999;
  const poseB = sampleClip(rootMotionWalkClip(), src, 0.25, 'once');
  const b = retargetPose(plan, poseB);
  assert.deepEqual(b.get('j_legL')!.rotation, savedLeg);
  assert.deepEqual(poseA.get('leg.L')!.rotation, savedSourceLeg);
});

test('拒绝未知骨、重复映射、缺根、层级倒置与非法数据', () => {
  const build = (
    mappingList: { sourceBoneId: string; targetBoneId: string }[],
    targetSkeleton: Skeleton = dst,
  ) => new RetargetPlan({ source: src, target: targetSkeleton, mapping: mappingList });
  const entries = mapping.map(([sourceBoneId, targetBoneId]) => ({ sourceBoneId, targetBoneId }));
  assert.throws(() => build([...entries, { sourceBoneId: 'ghost', targetBoneId: 'j_head' }]), /未知源骨骼/);
  assert.throws(() => build([...entries, { sourceBoneId: 'head', targetBoneId: 'ghost' }]), /未知目标骨骼/);
  assert.throws(
    () => build(entries.map((e) => (e.sourceBoneId === 'head' ? { ...e, sourceBoneId: 'spine' } : e))),
    /重复映射/,
  );
  assert.throws(
    () => build(entries.map((e) => (e.targetBoneId === 'j_head' ? { ...e, targetBoneId: 'j_spine' } : e))),
    /重复映射/,
  );
  assert.throws(() => build(entries.filter((e) => e.sourceBoneId !== 'hips')), /顶层根/);
  assert.throws(
    () => build(entries.map((e) => {
      if (e.sourceBoneId === 'spine') return { ...e, targetBoneId: 'j_head' };
      if (e.sourceBoneId === 'head') return { ...e, targetBoneId: 'j_spine' };
      return e;
    })),
    /层级次序/,
  );
  const scaled = new Skeleton(targetBones().map((b2) => (b2.id === 'j_legL' ? { ...b2, scale: [1, 2, 1] } : b2)));
  assert.throws(() => build(entries, scaled), /单位/);
  const partial = new Map([['hips', src.bindLocalTransform('hips')]]);
  assert.throws(() => retargetPose(plan, partial), /完整局部姿态/);
});

test('烘焙：时长不变、轨道用目标骨 ID、含两端且终点不折回首帧', () => {
  const clip = rootMotionWalkClip();
  const baked = bakeRetargetedClip(plan, clip, {
    sampleTimes: [0, 0.25, 0.5, 0.75, 1],
    rootTranslationScale: 1,
  });
  assert.equal(baked.duration, 1);
  const ids = baked.tracks.map((tr) => tr.boneId);
  assert.ok(ids.includes('j_hips'));
  assert.ok(!ids.includes('j_spine0'));
  for (const tr of baked.tracks) {
    assert.ok(dst.hasBone(tr.boneId));
    assert.equal(tr.rotations![0].time, 0);
    assert.equal(tr.rotations![tr.rotations!.length - 1].time, 1);
    assert.equal(tr.scales, undefined);
  }
  const rootTrack = baked.tracks.find((tr) => tr.boneId === 'j_hips')!;
  assert.deepEqual(rootTrack.translations![0].value, [0, 0.8, 0]);
  assert.deepEqual(rootTrack.translations![4].value, [0.4, 0.8, 0]);
});

test('烘焙采样点与逐点直接转换一致，倍率作用于根轨道', () => {
  const clip = rootMotionWalkClip();
  const baked = bakeRetargetedClip(plan, clip, {
    sampleTimes: [0, 0.25, 0.5, 0.75, 1],
    rootTranslationScale: 0.5,
    loop: 'once',
  });
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const direct = retargetPose(plan, sampleClip(clip, src, t, 'once'), 0.5);
    const sampled = sampleClip(baked, dst, t, 'once');
    for (const id of dst.boneIds) {
      assert.ok(qAngle(sampled.get(id)!.rotation, direct.get(id)!.rotation) < 1e-9);
      assert.deepEqual(sampled.get(id)!.translation, direct.get(id)!.translation);
      assert.deepEqual(sampled.get(id)!.scale, direct.get(id)!.scale);
    }
  }
  assert.throws(
    () => bakeRetargetedClip(plan, clip, { sampleTimes: [0.25, 0.5] }),
    /从 0 开始/,
  );
  assert.throws(
    () => bakeRetargetedClip(plan, clip, { sampleTimes: [0, 0.5, 0.5, 1] }),
    /严格递增/,
  );
  assert.throws(
    () => bakeRetargetedClip(plan, clip, { sampleTimes: [0, 0.5] }),
    /结束/,
  );
});

test('烘焙片段可直接交给根运动播放器，目标角色按倍率推进', () => {
  const baked = bakeRetargetedClip(plan, rootMotionWalkClip(), {
    sampleTimes: [0, 0.5, 1],
    rootTranslationScale: 0.5,
  });
  const player = new RootMotionPlayer({
    skeleton: dst,
    clip: baked,
    rootBoneId: 'j_hips',
    mode: 'once',
  });
  const frame = player.advance(1);
  assert.ok(Math.abs(frame.character.translation[0] - 0.2) < 1e-9);
  assert.deepEqual(frame.localPose.get('j_hips')!.translation, [0, 0.8, 0]);
});

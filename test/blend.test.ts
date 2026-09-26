import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton, evaluatePose, resolveMaskWeights, sampleClip } from '../src/index.js';
import { humanoidBones, walkClip, waveClip, quatZ, IDENTITY_QUAT } from './helpers.js';

const sk = new Skeleton(humanoidBones());
const walk = walkClip();
const wave = waveClip();

test('遮罩继承：子级继承最近祖先，根默认 0，显式 0 屏蔽继承', () => {
  const w = resolveMaskWeights(sk, { 'arm.R': 0.8, 'hand.L': 0 });
  assert.equal(w.get('hips'), 0);
  assert.equal(w.get('spine'), 0);
  assert.equal(w.get('arm.R'), 0.8);
  assert.equal(w.get('hand.R'), 0.8); // 继承 arm.R
  assert.equal(w.get('arm.L'), 0);
  assert.equal(w.get('hand.L'), 0); // 显式 0
  assert.throws(() => resolveMaskWeights(sk, { ghost: 1 }), /未知骨骼/);
  assert.throws(() => resolveMaskWeights(sk, { hips: 1.5 }), /\[0, 1\]/);
});

test('覆盖只影响遮罩骨骼，身体其余部分保持基础动作', () => {
  const t = 0.3;
  const result = evaluatePose(sk, { clip: walk, time: t, loop: 'loop' }, {
    clip: wave, time: 0.2, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  });
  const baseOnly = sampleClip(walk, sk, t, 'loop');
  // 左腿不受挥手影响
  assert.deepEqual(result.localPose.get('leg.L')!.rotation, baseOnly.get('leg.L')!.rotation);
  assert.deepEqual(result.localPose.get('hips')!.translation, baseOnly.get('hips')!.translation);
  // 右臂被挥手完全接管
  const wavePose = sampleClip(wave, sk, 0.2, 'loop');
  assert.deepEqual(result.localPose.get('arm.R')!.rotation, wavePose.get('arm.R')!.rotation);
  // hand.R 继承遮罩权重 1
  assert.deepEqual(result.localPose.get('hand.R')!.rotation, wavePose.get('hand.R')!.rotation);
});

test('强度与遮罩相乘：strength=0.5 × mask=0.5 → 0.25', async () => {
  const t = 0.2;
  const result = evaluatePose(sk, { clip: walk, time: t, loop: 'loop' }, {
    clip: wave, time: t, loop: 'loop', strength: 0.5, mask: { 'arm.R': 0.5 },
  });
  const baseRot = sampleClip(walk, sk, t, 'loop').get('arm.R')!.rotation; // 绑定值（walk 无此轨道）
  const overRot = sampleClip(wave, sk, t, 'loop').get('arm.R')!.rotation;
  const got = result.localPose.get('arm.R')!.rotation;
  // 与直接 0.25 权重 slerp 比较
  const { slerpQuat } = await import('../src/index.js');
  const expect = slerpQuat(baseRot, overRot, 0.25);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(got[i] - expect[i]) < 1e-9);
  assert.deepEqual(baseRot, IDENTITY_QUAT);
});

test('先局部混合再算世界：子骨骼世界矩阵反映父级混合结果', async () => {
  const result = evaluatePose(sk, { clip: walk, time: 0.25, loop: 'loop' }, {
    clip: wave, time: 0.4, loop: 'loop', strength: 1, mask: { 'arm.R': 1 },
  });
  // hand.R 的世界位置应等于 arm.R 世界矩阵 × hand.R 局部（挥手后的）
  const armWorld = result.worldMatrices.get('arm.R')!;
  const handLocal = result.localPose.get('hand.R')!;
  const handWorld = result.worldMatrices.get('hand.R')!;
  const { composeLocalMatrix } = await import('../src/index.js');
  const expect = armWorld.clone().multiply(
    composeLocalMatrix(handLocal.translation, handLocal.rotation, handLocal.scale));
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(handWorld.elements[i] - expect.elements[i]) < 1e-9);
  }
  // 挥手确实改变了右手世界位置（相对纯行走）
  const pure = evaluatePose(sk, { clip: walk, time: 0.25, loop: 'loop' });
  const a = result.worldMatrices.get('hand.R')!.elements;
  const b = pure.worldMatrices.get('hand.R')!.elements;
  assert.ok(Math.abs(a[12] - b[12]) + Math.abs(a[13] - b[13]) > 0.05);
});

test('无遮罩时覆盖全身；强度越界抛错', () => {
  const result = evaluatePose(sk, { clip: walk, time: 0.1, loop: 'loop' }, {
    clip: wave, time: 0.1, loop: 'loop', strength: 1,
  });
  const wavePose = sampleClip(wave, sk, 0.1, 'loop');
  assert.deepEqual(result.localPose.get('arm.R')!.rotation, wavePose.get('arm.R')!.rotation);
  assert.throws(() => evaluatePose(sk, { clip: walk, time: 0, loop: 'once' }, {
    clip: wave, time: 0, loop: 'once', strength: 1.2,
  }), /\[0, 1\]/);
});

test('quatZ 辅助 sanity', () => {
  const q = quatZ(Math.PI / 2);
  assert.ok(Math.abs(q[2] - Math.SQRT1_2) < 1e-12);
});

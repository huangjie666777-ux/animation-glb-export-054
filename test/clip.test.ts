import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton, sampleClip, slerpQuat, validateClip } from '../src/index.js';
import { humanoidBones, quatZ, walkClip, IDENTITY_QUAT } from './helpers.js';

const sk = new Skeleton(humanoidBones());

test('片段校验：时长、未知骨骼、时间越界与乱序', () => {
  assert.throws(() => validateClip({ name: 'x', duration: 0, tracks: [] }, sk), /时长/);
  assert.throws(
    () => validateClip({ name: 'x', duration: 1, tracks: [{ boneId: 'ghost' }] }, sk),
    /未知骨骼/,
  );
  assert.throws(
    () => validateClip({ name: 'x', duration: 1, tracks: [{ boneId: 'hips', translations: [{ time: 2, value: [0,0,0] }] }] }, sk),
    /超出片段范围/,
  );
  assert.throws(
    () => validateClip({ name: 'x', duration: 1, tracks: [{ boneId: 'hips', translations: [
      { time: 0.5, value: [0,0,0] }, { time: 0.5, value: [0,0,0] }] }] }, sk),
    /严格递增/,
  );
});

test('平移线性插值，端点外夹取', () => {
  const pose = sampleClip(walkClip(), sk, 0.25, 'once');
  const hips = pose.get('hips')!;
  assert.ok(Math.abs(hips.translation[1] - 1.025) < 1e-9);
  const before = sampleClip(walkClip(), sk, 0, 'once').get('hips')!;
  assert.equal(before.translation[1], 1);
});

test('旋转走最短弧且保持单位四元数', () => {
  // 从 +170° 到 -170°（等价 190°），最短弧应经过 180° 一侧而非回到 0°。
  const a = quatZ((170 * Math.PI) / 180);
  const b = quatZ((-170 * Math.PI) / 180);
  const mid = slerpQuat(a, b, 0.5);
  const len = Math.hypot(...mid);
  assert.ok(Math.abs(len - 1) < 1e-9);
  // 中点应接近 180° 旋转（[0,0,±1,0]），即 z 分量绝对值接近 1。
  assert.ok(Math.abs(Math.abs(mid[2]) - 1) < 1e-6);
});

test('缺失轨道回退绑定值', () => {
  const pose = sampleClip(walkClip(), sk, 0.3, 'once');
  assert.deepEqual(pose.get('head')!.rotation, IDENTITY_QUAT);
  assert.deepEqual(pose.get('head')!.translation, [0, 0.3, 0]);
});

test('once 停在末帧，loop 按时长取模，拒绝负时间', () => {
  const clip = walkClip();
  const once = sampleClip(clip, sk, 5, 'once').get('leg.L')!;
  const end = sampleClip(clip, sk, 1, 'once').get('leg.L')!;
  assert.deepEqual(once.rotation, end.rotation);
  const loop = sampleClip(clip, sk, 1.25, 'loop').get('hips')!;
  const quarter = sampleClip(clip, sk, 0.25, 'loop').get('hips')!;
  assert.deepEqual(loop.translation, quarter.translation);
  assert.throws(() => sampleClip(clip, sk, -0.1, 'loop'), /非负/);
});

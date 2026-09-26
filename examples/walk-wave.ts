/**
 * 实际示例：人形角色行走（循环基础层）叠加右臂挥手（遮罩覆盖层），
 * 打印混合后的局部/世界姿态与 CPU 蒙皮变形顶点。
 * 运行：npm run example
 */
import {
  Skeleton,
  evaluatePose,
  skinVertices,
  type SkinInfluence,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, walkClip, waveClip } from '../test/helpers.js';

const skeleton = new Skeleton(humanoidBones());
const walk = walkClip();
const wave = waveClip();

const TIME = 1.3; // 秒：walk 循环内 0.3s，wave 循环内 0.5s

const pose = evaluatePose(
  skeleton,
  { clip: walk, time: TIME, loop: 'loop' },
  { clip: wave, time: TIME, loop: 'loop', strength: 1, mask: { 'arm.R': 1 } },
);

const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(4)).join(', ');

console.log('=== 混合局部姿态 (t=' + TIME + 's, walk+wave@arm.R) ===');
for (const id of skeleton.evalOrder) {
  const t = pose.localPose.get(id)!;
  console.log(
    id.padEnd(7),
    'T[' + fmt(t.translation) + ']',
    'R[' + fmt(t.rotation) + ']',
    'S[' + fmt(t.scale) + ']',
  );
}

console.log('\n=== 关键骨骼世界位置 ===');
for (const id of ['hips', 'hand.L', 'hand.R', 'leg.L', 'leg.R']) {
  const e = pose.worldMatrices.get(id)!.elements;
  console.log(id.padEnd(7), 'pos[' + fmt([e[12], e[13], e[14]]) + ']');
}

// 对比：纯行走（无覆盖）的右手位置，验证挥手生效且腿部不受影响。
const pureWalk = evaluatePose(skeleton, { clip: walk, time: TIME, loop: 'loop' });
const handR = (p: typeof pose) => {
  const e = p.worldMatrices.get('hand.R')!.elements;
  return [e[12], e[13], e[14]] as const;
};
console.log('\nhand.R 世界位置  纯行走: [' + fmt(handR(pureWalk)) + ']  叠加挥手: [' + fmt(handR(pose)) + ']');

// 简单网格：右手一个顶点 + 脊柱处一个双骨骼顶点 + 零权重顶点。
const vertices: Vec3[] = [
  [0.55, 1.35, 0],   // 右手绑定位置
  [0, 1.25, 0],      // 脊柱附近
  [9, 9, 9],         // 零权重，应保持不动
];
const weights: SkinInfluence[][] = [
  [{ boneId: 'hand.R', weight: 1 }],
  [{ boneId: 'hips', weight: 2 }, { boneId: 'spine', weight: 2 }], // 非归一，内部归一化
  [],
];
const deformed = skinVertices(skeleton, vertices, weights, pose.worldMatrices);
console.log('\n=== 蒙皮变形顶点（角色局部空间） ===');
for (let i = 0; i < vertices.length; i++) {
  console.log('v' + i, '绑定 [' + fmt(vertices[i]) + '] -> 变形 [' + fmt(deformed[i]) + ']');
}

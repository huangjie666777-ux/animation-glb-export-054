/**
 * 完整示例：根运动播放实例循环行走，角色沿 +X 推进；每帧对固定世界目标点
 * 执行世界空间两骨骼 IK（spine -> arm.R -> hand.R），循环移动后手部仍然
 * 贴合同一个固定世界目标。结果姿态送入世界蒙皮（角色矩阵只应用一次）。
 *
 * 运行：npm run example:target
 */
import { Vector3 } from 'three';
import {
  Skeleton,
  RootMotionPlayer,
  solveWorldTwoBoneIk,
  skinVerticesToWorld,
  type SkinInfluence,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, rootMotionWalkClip } from '../test/helpers.js';

const skeleton = new Skeleton(humanoidBones());
const player = new RootMotionPlayer({
  skeleton,
  clip: rootMotionWalkClip(),
  rootBoneId: 'hips',
  mode: 'loop',
  initialTransform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
});

// 固定世界目标与弯曲参考点（整段循环中都不变）。
const worldTarget: Vec3 = [1.3, 1.35, 0.1];
const worldBend: Vec3 = [1.0, 1.85, 0.4];

// 绑定姿态下位于右手的顶点；最终输出世界坐标。
const vertices: Vec3[] = [[0.55, 1.35, 0]];
const weights: SkinInfluence[][] = [[{ boneId: 'hand.R', weight: 1 }]];

const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(4)).join(', ');

console.log('=== 循环行走：手部贴合固定世界目标 [' + fmt(worldTarget) + '] ===');
const steps = [0.4, 0.4, 0.4, 0.4, 0.4, 0.1, 0.1]; // 分步推进，跨越两个完整循环
let frame = player.advance(0);
for (const dt of steps) {
  frame = player.advance(dt);
  const ik = solveWorldTwoBoneIk(skeleton, frame.localPose, {
    rootJointId: 'spine',
    middleJointId: 'arm.R',
    endJointId: 'hand.R',
    worldTarget,
    worldBendReference: worldBend,
    characterMatrix: frame.characterMatrix,
    weight: 1,
  });
  const worldVerts = skinVerticesToWorld(
    skeleton,
    vertices,
    weights,
    ik.worldMatrices,
    frame.characterMatrix,
  );
  const hipsLocal = frame.localPose.get('hips')!;
  console.log(
    't=' + frame.time.toFixed(1) + 's  clipT=' + frame.clipTime.toFixed(1),
    '角色x=' + frame.character.translation[0].toFixed(3),
    '根局部T=[' + fmt(hipsLocal.translation) + ']',
  );
  console.log(
    '   末端=[' + fmt(ik.worldEndPosition) + ']',
    '可达=' + ik.reachable,
    '残差=' + ik.distanceToTarget.toFixed(6),
    '世界顶点=[' + fmt(worldVerts[0]) + ']',
  );
}

// 一次推进到相同时刻，结果必须与分步推进一致。
const total = steps.reduce((a, b) => a + b, 0);
const direct = new RootMotionPlayer({
  skeleton,
  clip: rootMotionWalkClip(),
  rootBoneId: 'hips',
  mode: 'loop',
}).advance(total);
const same = new Vector3(...direct.character.translation).distanceTo(
  new Vector3(...frame.character.translation),
);
console.log('\n分步推进与一次推进角色位置差异: ' + same.toExponential(2) + '（应为 0）');

// once 模式到末帧后不再移动。
const once = new RootMotionPlayer({
  skeleton: new Skeleton(humanoidBones()),
  clip: rootMotionWalkClip(),
  rootBoneId: 'hips',
  mode: 'once',
});
once.advance(3);
const atEnd = once.characterTransform().translation.slice();
once.advance(10);
const afterEnd = once.characterTransform().translation[0];
console.log('once 末帧角色x=' + atEnd[0].toFixed(3) + '，再推进后 x=' + afterEnd.toFixed(3) + '（应相同）');

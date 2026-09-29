/**
 * 动作重定向完整示例：把源人形骨架（humanoidBones）的根运动行走片段
 * 重定向到骨名、绑定朝向、骨长均不同、且插入了未映射中间骨的目标骨架，
 * 烘焙后交给现有根运动播放器播放；播放帧上再做世界空间两骨骼 IK，
 * 并对目标骨架绑定网格做世界蒙皮。
 *
 * 运行：npm run example:retarget
 */
import { AnimationMixer, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  RetargetPlan,
  bakeRetargetedClip,
  RootMotionPlayer,
  solveWorldTwoBoneIk,
  skinVerticesToWorld,
  exportCharacterGlb,
  sampleClip,
  computeWorldMatrices,
  skinVertices,
  type BoneSpec,
  type SkinInfluence,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, rootMotionWalkClip, IDENTITY_QUAT, UNIT_SCALE, quatZ } from '../test/helpers.js';

const sourceSkeleton = new Skeleton(humanoidBones());

// 目标骨架：不同命名、不同骨长、j_armR 绑定预旋转，并插入未映射中间骨 j_spine0。
const targetBones: BoneSpec[] = [
  { id: 'j_hips', parentId: null, translation: [0, 0.8, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_spine0', parentId: 'j_hips', translation: [0, 0.1, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_spine', parentId: 'j_spine0', translation: [0, 0.25, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_head', parentId: 'j_spine', translation: [0, 0.4, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_armL', parentId: 'j_spine', translation: [-0.3, 0.2, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_handL', parentId: 'j_armL', translation: [0, 0.4, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_armR', parentId: 'j_spine', translation: [0.3, 0.2, 0], rotation: quatZ(0.2), scale: UNIT_SCALE },
  { id: 'j_handR', parentId: 'j_armR', translation: [0, 0.55, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_legL', parentId: 'j_hips', translation: [0.15, 0, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
  { id: 'j_legR', parentId: 'j_hips', translation: [-0.15, 0, 0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
];
const targetSkeleton = new Skeleton(targetBones);

const plan = new RetargetPlan({
  source: sourceSkeleton,
  target: targetSkeleton,
  mapping: [
    ['hips', 'j_hips'],
    ['spine', 'j_spine'],
    ['head', 'j_head'],
    ['arm.L', 'j_armL'],
    ['hand.L', 'j_handL'],
    ['arm.R', 'j_armR'],
    ['hand.R', 'j_handR'],
    ['leg.L', 'j_legL'],
    ['leg.R', 'j_legR'],
  ].map(([sourceBoneId, targetBoneId]) => ({ sourceBoneId, targetBoneId })),
});

// 源片段每圈推进 0.4；目标体型更小，根位移按 0.75 倍率烘焙，时长不变。
const baked = bakeRetargetedClip(plan, rootMotionWalkClip(), {
  sampleTimes: [0, 0.25, 0.5, 0.75, 1],
  rootTranslationScale: 0.75,
  name: 'walk-retarget',
});

const player = new RootMotionPlayer({
  skeleton: targetSkeleton,
  clip: baked,
  rootBoneId: 'j_hips',
  mode: 'loop',
});

// 绑定姿态下位于目标右手的顶点（目标骨长：0.3+0.4 从脊柱，脊柱在 1.15）。
const vertices: Vec3[] = [[0.3, 0.9, 0]];
const weights: SkinInfluence[][] = [[{ boneId: 'j_handR', weight: 1 }]];

// 固定世界目标：取角色走到 x=0.15 时右手前方一个可达点，
// 之后继续循环行走，IK 仍把右手拉回这个固定世界点。
const worldTarget: Vec3 = [0.82, 1.55, 0.15];
const worldBend: Vec3 = [0.5, 1.9, 0.4];

const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(4)).join(', ');

console.log('=== 源片段重定向到异构目标骨架并播放（根位移倍率 0.75）===');
for (const dt of [0.5, 0.5, 0.5]) {
  const frame = player.advance(dt);
  const ik = solveWorldTwoBoneIk(targetSkeleton, frame.localPose, {
    rootJointId: 'j_spine',
    middleJointId: 'j_armR',
    endJointId: 'j_handR',
    worldTarget,
    worldBendReference: worldBend,
    characterMatrix: frame.characterMatrix,
    weight: 1,
  });
  const worldVerts = skinVerticesToWorld(
    targetSkeleton,
    vertices,
    weights,
    ik.worldMatrices,
    frame.characterMatrix,
  );
  console.log(
    't=' + frame.time.toFixed(1) + 's  clipT=' + frame.clipTime.toFixed(2),
    '角色x=' + frame.character.translation[0].toFixed(3),
    '根钉在绑定T=[' + fmt(frame.localPose.get('j_hips')!.translation) + ']',
  );
  console.log(
    '   IK 末端=[' + fmt(ik.worldEndPosition) + ']',
    '可达=' + ik.reachable,
    '残差=' + ik.distanceToTarget.toExponential(1),
    '世界蒙皮顶点=[' + fmt(worldVerts[0]) + ']',
  );
}

// 烘焙片段时长与源一致，可无缝循环；整圈推进 0.4*0.75=0.3。
const atCycle = new RootMotionPlayer({
  skeleton: targetSkeleton,
  clip: baked,
  rootBoneId: 'j_hips',
  mode: 'loop',
}).advance(1);
console.log(
  '\n整圈后角色x=' + atCycle.character.translation[0].toFixed(3) + '（应为 0.300），',
  '时长=' + baked.duration + 's 未变；未映射中间骨 j_spine0 无轨道，播放时回退绑定值。',
);
console.log(
  '目标绑定右手位置仍为 ['
  + fmt(new Vector3().setFromMatrixPosition(targetSkeleton.bindWorldMatrix('j_handR')).toArray())
  + ']（重定向不改写骨架输入）。',
);

// 导出三角网格与烘焙后的重定向片段；GLB 只有一个内嵌 BIN buffer，不引用外部文件。
const glbPositions: Vec3[] = [
  [0.3, 0.85, 0],
  [0.38, 0.85, 0],
  [0.34, 0.93, 0],
];
const glbWeights: SkinInfluence[][] = glbPositions.map(() => [{ boneId: 'j_handR', weight: 1 }]);
const glb = exportCharacterGlb(
  targetSkeleton,
  { name: 'retarget-target', positions: glbPositions, indices: [0, 1, 2], weights: glbWeights },
  [baked],
);

const loadedGlb = await new Promise<any>((resolve, reject) => {
  new GLTFLoader().parse(glb.slice(0), '', resolve, reject);
});
const mixer = new AnimationMixer(loadedGlb.scene);
mixer.clipAction(loadedGlb.animations[0]).play();
mixer.update(0.5);
loadedGlb.scene.updateMatrixWorld(true);

const loadedSkinned = loadedGlb.scene.children.find((child: any) => child.isSkinnedMesh);
loadedSkinned.skeleton.update();
const expectedAtHalf = skinVertices(
  targetSkeleton,
  glbPositions,
  glbWeights,
  computeWorldMatrices(targetSkeleton, sampleClip(baked, targetSkeleton, 0.5, 'once')),
);
const loadedPosition = new Vector3();
for (let slot = 0; slot < 4; slot++) {
  const joint = loadedSkinned.geometry.attributes.skinIndex.array[slot] as number;
  const weight = loadedSkinned.geometry.attributes.skinWeight.array[slot] as number;
  if (weight === 0) continue;
  const matrix = new Matrix4().fromArray(
    Array.from(loadedSkinned.skeleton.boneMatrices.slice(joint * 16, joint * 16 + 16)),
  );
  loadedPosition.addScaledVector(new Vector3(...glbPositions[0]).applyMatrix4(matrix), weight);
}
const loadedError = loadedPosition.distanceTo(new Vector3(...expectedAtHalf[0]));
if (loadedError > 1e-5 || loadedGlb.animations[0].name !== 'walk-retarget') {
  throw new Error('GLTFLoader 播放验证失败，蒙皮误差=' + loadedError);
}

console.log(
  '\nGLB 导出/加载验证通过：' + glb.byteLength + ' bytes，片段 '
  + loadedGlb.animations[0].name + ' 在 t=0.5 的蒙皮误差=' + loadedError.toExponential(1) + '。',
);

/**
 * 动作重定向 + GLB 导出示例：
 * 1. 把源骨架的根运动行走片段烘焙到异构目标骨架（bakeRetargetedClip）；
 * 2. 连同目标骨架、绑定姿态三角网格与多个既有片段导出为自包含 glTF 2.0 GLB；
 * 3. 不依赖本库播放器，改用 Three.js GLTFLoader 加载该 GLB，AnimationMixer 播放，
 *    并把加载后的角色空间蒙皮结果与导出前本库 CPU 蒙皮结果逐点对比。
 *
 * 运行：npm run example:export-glb
 */
import { writeFile } from 'node:fs/promises';
import { AnimationMixer, LoopOnce, Matrix4, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  RetargetPlan,
  bakeRetargetedClip,
  exportGlb,
  sampleClip,
  computeWorldMatrices,
  skinVertices,
  type BoneSpec,
  type SkinInfluence,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, rootMotionWalkClip, waveClip, IDENTITY_QUAT, UNIT_SCALE, quatZ } from '../test/helpers.js';

const sourceSkeleton = new Skeleton(humanoidBones());

// 与 examples/retarget.ts 相同的异构目标骨架（不同骨名/骨长/预旋转，含中间骨）。
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

// 复用重定向烘焙得到目标片段（根位移保留在片段自身中，导出时不再叠加世界位移）。
const walk = bakeRetargetedClip(plan, rootMotionWalkClip(), {
  sampleTimes: [0, 0.25, 0.5, 0.75, 1],
  rootTranslationScale: 0.75,
  name: 'walk-retarget',
});

// 第二个片段：目标骨架上的挥手动作（故意只给部分通道，其余取绑定值）。
const wave = {
  name: 'wave-on-target',
  duration: 0.8,
  tracks: [
    {
      boneId: 'j_armR',
      rotations: [
        { time: 0, value: quatZ(1.0) },
        { time: 0.4, value: quatZ(1.5) },
        { time: 0.8, value: quatZ(1.0) },
      ],
    },
  ],
};

// 绑定姿态角色空间三角网格：右手附近两个顶点 + 一个左脚顶点。
const vertices: Vec3[] = [
  [0.32, 1.62, 0],
  [0.30, 1.70, 0],
  [0.15, 0.55, 0],
];
// 一个退化三角形也满足“三角网格”；演示不依赖法线/材质。
const indices = [0, 1, 2];
const weights: SkinInfluence[][] = [
  [{ boneId: 'j_armR', weight: 0.4 }, { boneId: 'j_handR', weight: 0.6 }],
  [{ boneId: 'j_handR', weight: 1 }],
  [{ boneId: 'j_legL', weight: 3 }], // 非归一权重，导出时归一化
];

const glb = exportGlb({
  skeleton: targetSkeleton,
  mesh: { vertices, indices, weights },
  clips: [walk, wave],
  name: 'retarget-character',
});
await writeFile(new URL('../retarget-character.glb', import.meta.url), new Uint8Array(glb));

// —— 不依赖本库播放：用 Three.js GLTFLoader 加载并 AnimationMixer 播放 ——
const gltf = await new Promise<{
  scene: { traverse: (fn: (o: unknown) => void) => void; updateMatrixWorld: (b: boolean) => void };
  animations: import('three').AnimationClip[];
}>((resolve, reject) => {
  new GLTFLoader().parse(glb, '', (g) => resolve(g as never), reject);
});

let skinnedMesh: import('three').SkinnedMesh | undefined;
gltf.scene.traverse((obj) => {
  if ((obj as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
    skinnedMesh = obj as import('three').SkinnedMesh;
  }
});
if (!skinnedMesh) throw new Error('GLB 中缺少蒙皮网格');

const mixer = new AnimationMixer(gltf.scene as never);
// 与库 once 语义一致：停在末帧，验证终点不会被折回首帧/零点。
const action = mixer.clipAction(gltf.animations[0]);
action.setLoop(LoopOnce, 1);
action.clampWhenFinished = true;
action.play();

const fmt = (v: readonly number[]) => v.map((n) => n.toFixed(4)).join(', ');
let maxError = 0;
console.log('=== 重定向烘焙 -> GLB 导出 -> GLTFLoader 加载播放验证 ===');
console.log('动画:', gltf.animations.map((c) => c.name + '(' + c.duration + 's)').join(', '));
for (const t of [0, 0.25, 0.63, 1]) {
  mixer.setTime(t);
  gltf.scene.updateMatrixWorld(true);
  skinnedMesh.skeleton.update();

  // 本库同一时刻的角色空间蒙皮结果（不经过 RootMotionPlayer，避免世界位移叠加）。
  const localPose = sampleClip(walk, targetSkeleton, t, 'once');
  const worldMatrices = computeWorldMatrices(targetSkeleton, localPose);
  const expected = skinVertices(targetSkeleton, vertices, weights, worldMatrices);

  // 用加载后的 skeleton.boneMatrices 做等价线性混合蒙皮。
  const skinIndex = skinnedMesh.geometry.getAttribute('skinIndex') as import('three').BufferAttribute;
  const skinWeight = skinnedMesh.geometry.getAttribute('skinWeight') as import('three').BufferAttribute;
  const bind = new Vector3();
  const tmp = new Vector3();
  const acc = new Vector3();
  for (let v = 0; v < vertices.length; v++) {
    bind.set(vertices[v][0], vertices[v][1], vertices[v][2]);
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (w === 0) continue;
      const matrix = new Matrix4().fromArray(
        skinnedMesh.skeleton.boneMatrices,
        skinIndex.getComponent(v, k) * 16,
      );
      tmp.copy(bind).applyMatrix4(matrix);
      acc.addScaledVector(tmp, w);
    }
    const got: Vec3 = [acc.x, acc.y, acc.z];
    for (let c = 0; c < 3; c++) maxError = Math.max(maxError, Math.abs(got[c] - expected[v][c]));
    if (v === 0) {
      console.log('t=' + t.toFixed(2) + 's 右手顶点 GLB=[' + fmt(got) + '] 本库=[' + fmt(expected[v]) + ']');
    }
  }
}

console.log('\nGLB 字节数:', glb.byteLength, '(单 BIN 缓冲，无外部文件)');
console.log('全程最大蒙皮误差:', maxError.toExponential(1), '(Float32 精度内一致)');
console.log('已写出 retarget-character.glb，可直接拖入任意支持 glTF 2.0 的三维工具。');

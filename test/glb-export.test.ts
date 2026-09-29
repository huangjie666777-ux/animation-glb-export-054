import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnimationMixer, Matrix4, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  Skeleton,
  exportGlb,
  skinVertices,
  sampleClip,
  computeWorldMatrices,
  type AnimationClip,
  type SkinInfluence,
  type SkinMesh,
  type Vec3,
} from '../src/index.js';
import { humanoidBones, walkClip, waveClip, quatZ } from './helpers.js';

interface ParsedGlb {
  scene: { traverse: (fn: (o: unknown) => void) => void; updateMatrixWorld: (b: boolean) => void };
  animations: import('three').AnimationClip[];
  parser: { json: Record<string, unknown> };
}

function makeMesh(): SkinMesh {
  // 两个顶点：右手附近（受 arm.R/hand.R 混合影响）、左腿上（受 leg.L 影响）。
  const vertices: Vec3[] = [
    [0.4, 1.4, 0],
    [0.1, 0.6, 0],
  ];
  const weights: SkinInfluence[][] = [
    [
      { boneId: 'arm.R', weight: 0.25 },
      { boneId: 'hand.R', weight: 0.75 },
    ],
    [{ boneId: 'leg.L', weight: 2 }], // 非归一权重，导出时应归一化
  ];
  return { vertices, indices: [0, 1, 1], weights };
}

function parseGlb(glb: ArrayBuffer): Promise<ParsedGlb> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(glb, '', (gltf) => resolve(gltf as unknown as ParsedGlb), reject);
  });
}

test('GLB 头、分块对齐与 JSON 结构符合 glTF 2.0', async () => {
  const sk = new Skeleton(humanoidBones());
  const glb = exportGlb({ skeleton: sk, mesh: makeMesh(), clips: [walkClip()] });
  assert.ok(glb.byteLength % 4 === 0);
  const view = new DataView(glb);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), glb.byteLength);
  const jsonLen = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a);
  assert.ok(jsonLen % 4 === 0);
  const jsonText = new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen));
  const json = JSON.parse(jsonText);
  assert.equal(json.asset.version, '2.0');
  assert.equal(json.buffers.length, 1);
  assert.equal(json.buffers[0].uri, undefined); // 无外部引用
  assert.equal(json.buffers[0].byteLength % 4, 0);
  for (const bv of json.bufferViews) {
    assert.equal(bv.buffer, 0);
    assert.equal((bv.byteOffset ?? 0) % 4, 0);
    assert.equal(bv.byteLength % 4, 0);
  }
  // 关节节点顺序 = evalOrder；父子层级完整。
  const idToNode = new Map<string, number>();
  json.nodes.forEach((n: { name?: string }, i: number) => {
    if (n.name && sk.hasBone(n.name)) idToNode.set(n.name, i);
  });
  assert.equal(idToNode.size, sk.boneIds.length);
  for (const id of sk.evalOrder) {
    const parent = sk.parentIndex.get(id)!;
    if (parent !== null) {
      const parentNode = json.nodes[idToNode.get(parent)!];
      assert.ok(parentNode.children.includes(idToNode.get(id)));
    }
  }
  assert.deepEqual(json.skins[0].joints, sk.evalOrder.map((id) => idToNode.get(id)));
  // 加载一遍确认引用完整。
  const parsed = await parseGlb(glb);
  assert.equal(parsed.animations.length, 1);
  assert.equal((parsed.animations[0] as { name: string }).name, 'walk');
});

test('多片段：名称、时长、TRS 三通道与缺失通道绑定值', async () => {
  const sk = new Skeleton(humanoidBones());
  // scale 通道 + 未覆盖首尾的平移通道 + 缺通道的骨骼。
  const clip: AnimationClip = {
    name: 'partial',
    duration: 2,
    tracks: [
      {
        boneId: 'spine',
        translations: [
          { time: 0.5, value: [0, 0.25, 0] },
          { time: 1.5, value: [0, 0.35, 0] },
        ],
        scales: [{ time: 1, value: [1, 1.2, 1] }],
      },
      {
        boneId: 'head',
        rotations: [{ time: 2, value: quatZ(0.3) }],
      },
    ],
  };
  const glb = exportGlb({ skeleton: sk, mesh: makeMesh(), clips: [walkClip(), waveClip(), clip] });
  const parsed = await parseGlb(glb);
  assert.deepEqual(parsed.animations.map((a) => (a as { name: string }).name), ['walk', 'wave', 'partial']);
  const partialAnim = parsed.animations[2];
  assert.equal(partialAnim.duration, 2);
  // three 为每个通道生成一条 PropertyBinding 轨道；spine 的 TR 都应出现。
  const bindings = partialAnim.tracks.map((tr) => tr.name).sort();
  assert.ok(bindings.some((n) => n.endsWith('.position')));
  assert.ok(bindings.some((n) => n.endsWith('.quaternion')));
  assert.ok(bindings.some((n) => n.endsWith('.scale')));
  const json = parsed.parser.json as unknown as {
    animations: { samplers: { input: number; interpolation: string }[] }[];
    accessors: { count: number }[];
  };
  const partial = json.animations[2];
  assert.deepEqual(
    partial.samplers.map((s) => s.interpolation),
    partial.samplers.map(() => 'LINEAR'),
  );
  for (const sampler of partial.samplers) {
    const count = json.accessors[sampler.input].count;
    assert.ok(count >= 2);
  }
});

test('非法输入拒绝且不修改原数据', () => {
  const sk = new Skeleton(humanoidBones());
  const base = makeMesh();
  const verticesSnapshot = base.vertices.map((v) => [...v]);
  const reject = (mesh: SkinMesh, message: string): void => {
    assert.throws(
      () => exportGlb({ skeleton: sk, mesh, clips: [] }),
      new RegExp(message),
    );
  };
  reject({
    ...base,
    vertices: [[0, NaN, 0], base.vertices[1]],
  }, '非法数值');
  reject({ ...base, indices: [0, 0, 9] }, '越界');
  reject({ ...base, indices: [0, 0] }, '3 的倍数');
  reject(
    { ...base, weights: [[{ boneId: 'ghost', weight: 1 }], base.weights[1]] },
    '未知骨骼',
  );
  reject(
    { ...base, weights: [[{ boneId: 'arm.R', weight: -0.1 }], base.weights[1]] },
    '非法权重',
  );
  reject(
    { ...base, weights: [[{ boneId: 'arm.R', weight: 0 }], base.weights[1]] },
    '零总权重',
  );
  reject(
    {
      ...base,
      weights: [
        [{ boneId: 'arm.R', weight: 0.3 }, { boneId: 'hand.R', weight: 0.3 },
          { boneId: 'spine', weight: 0.2 }, { boneId: 'head', weight: 0.1 },
          { boneId: 'hips', weight: 0.1 }],
        base.weights[1],
      ],
    },
    '超过 4',
  );
  assert.deepEqual(base.vertices.map((v) => [...v]), verticesSnapshot);
});

test('GLTFLoader 加载后同一时刻蒙皮结果与本库一致', async () => {
  const sk = new Skeleton(humanoidBones());
  const mesh = makeMesh();
  const clip = walkClip();
  const glb = exportGlb({ skeleton: sk, mesh, clips: [clip] });
  const gltf = await parseGlb(glb);

  let skinned: SkinnedMesh | undefined;
  gltf.scene.traverse((obj) => {
    if ((obj as { isSkinnedMesh?: boolean }).isSkinnedMesh) {
      skinned = obj as SkinnedMesh;
    }
  });
  assert.ok(skinned);
  const sm = skinned!;
  const mixer = new AnimationMixer(gltf.scene as never);
  const actionClip = gltf.animations[0];
  mixer.clipAction(actionClip).play();

  const probeTimes = [0, 0.12, 0.5, 0.73, 1];
  for (const t of probeTimes) {
    mixer.setTime(t);
    gltf.scene.updateMatrixWorld(true);
    sm.skeleton.update();
    const localPose = sampleClip(clip, sk, t, 'once');
    const worldMatrices = computeWorldMatrices(sk, localPose);
    const expected = skinVertices(sk, mesh.vertices, mesh.weights, worldMatrices);
    const weightAttr = sm.geometry.getAttribute('skinWeight') as import('three').BufferAttribute;
    const indexAttr = sm.geometry.getAttribute('skinIndex') as import('three').BufferAttribute;
    const bind = new Vector3();
    const tmp = new Vector3();
    const acc = new Vector3();
    for (let v = 0; v < mesh.vertices.length; v++) {
      bind.set(mesh.vertices[v][0], mesh.vertices[v][1], mesh.vertices[v][2]);
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = weightAttr.getComponent(v, k);
        if (w === 0) continue;
        const bone = indexAttr.getComponent(v, k);
        const matrix = new Matrix4().fromArray(sm.skeleton.boneMatrices, bone * 16);
        tmp.copy(bind).applyMatrix4(matrix);
        acc.addScaledVector(tmp, w);
      }
      const got: Vec3 = [acc.x, acc.y, acc.z];
      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(got[c] - expected[v][c]) < 1e-4,
          't=' + t + ' v=' + v + ' c=' + c + ' got=' + got[c] + ' exp=' + expected[v][c],
        );
      }
    }
  }
});

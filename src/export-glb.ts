import type { GlbExportOptions, LocalTransform, SkinMesh, Vec3 } from './types.js';
import type { Skeleton } from './skeleton.js';
import { packSkinMesh } from './skin-mesh-data.js';
import { buildGltfAnimation } from './gltf-animation.js';
import {
  GlbBuilder,
  GLTF_ARRAY_BUFFER,
  GLTF_ELEMENT_ARRAY_BUFFER,
  GLTF_FLOAT,
  GLTF_UNSIGNED_INT,
  GLTF_UNSIGNED_SHORT,
} from './glb-builder.js';

interface GltfNode {
  name?: string;
  children?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  mesh?: number;
  skin?: number;
}

function copyVec3(v: Vec3): [number, number, number] {
  return [v[0], v[1], v[2]];
}

function copyLocal(t: LocalTransform): GltfNode {
  return {
    translation: copyVec3(t.translation),
    rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
    scale: copyVec3(t.scale),
  };
}

/**
 * 导出单根骨架 + 绑定姿态三角网格 + 多个动画片段为自包含 glTF 2.0 GLB 字节。
 *
 * 输出不引用任何外部文件（无材质/贴图）：
 * - 关节节点按骨架求值顺序排列（输入骨骼可乱序），完整保留层级与绑定局部 TRS；
 * - 网格节点位于场景根（单位变换），skin.joints 顺序与逆绑定矩阵/顶点权重序号一致；
 * - 权重在导出时归一化，拒绝未知骨骼、负权重、零总权重、非有限值与越界索引；
 * - 每个片段输出独立 animation，线性平移/缩放 + 最短弧旋转，缺失通道取节点绑定值，
 *   采样器覆盖 [0, duration]，未覆盖端值自动延续；根运动片段不叠加任何世界位移。
 * 不修改任何输入。
 */
export function exportGlb(options: GlbExportOptions): ArrayBuffer {
  if (!options || !options.skeleton) throw new Error('GLB 导出缺少骨架');
  const skeleton = options.skeleton;
  const mesh: SkinMesh | undefined = options.mesh;
  if (!mesh) throw new Error('GLB 导出缺少网格');
  const clips = options.clips;
  if (!Array.isArray(clips)) throw new Error('GLB 导出 clips 必须是数组');

  const roots = skeleton.boneIds.filter((id) => skeleton.parentIndex.get(id) === null);
  if (roots.length !== 1) {
    throw new Error('GLB 导出要求单根骨架，当前顶层骨数量: ' + roots.length);
  }

  const builder = new GlbBuilder();

  // 关节节点：节点索引即 skin.joints / 逆绑定矩阵 / 顶点权重中的关节序号。
  const nodeIndexOf = new Map<string, number>();
  skeleton.evalOrder.forEach((id, index) => nodeIndexOf.set(id, index));
  const nodes: GltfNode[] = skeleton.evalOrder.map((id) => ({
    name: id,
    ...copyLocal(skeleton.bindLocalTransform(id)),
  }));
  for (const id of skeleton.evalOrder) {
    const parent = skeleton.parentIndex.get(id)!;
    if (parent !== null) {
      const parentNode = nodes[nodeIndexOf.get(parent)!];
      (parentNode.children ??= []).push(nodeIndexOf.get(id)!);
    }
  }

  // 逆绑定矩阵（列主序，MAT4），顺序与关节节点一致。
  const inverseBind = new Float32Array(skeleton.evalOrder.length * 16);
  skeleton.evalOrder.forEach((id, i) => {
    const elements = skeleton.inverseBindMatrix(id).elements;
    inverseBind.set(elements, i * 16);
  });
  const inverseBindAccessor = builder.addAccessor(
    inverseBind,
    'MAT4',
    GLTF_FLOAT,
    skeleton.evalOrder.length,
  );

  // 校验并打包网格（不修改输入；权重在此归一化）。
  const packed = packSkinMesh(skeleton, mesh, nodeIndexOf);
  const positionAccessor = builder.addAccessor(
    packed.positions,
    'VEC3',
    GLTF_FLOAT,
    packed.vertexCount,
    {
      target: GLTF_ARRAY_BUFFER,
      min: packed.min,
      max: packed.max,
      byteStride: 3 * 4,
    },
  );
  const indicesAccessor = builder.addAccessor(
    packed.indices,
    'SCALAR',
    GLTF_UNSIGNED_INT,
    packed.indices.length,
    { target: GLTF_ELEMENT_ARRAY_BUFFER },
  );
  const jointsAccessor = builder.addAccessor(
    packed.joints,
    'VEC4',
    GLTF_UNSIGNED_SHORT,
    packed.vertexCount,
    { target: GLTF_ARRAY_BUFFER, byteStride: 4 * 2 },
  );
  const weightsAccessor = builder.addAccessor(
    packed.weights,
    'VEC4',
    GLTF_FLOAT,
    packed.vertexCount,
    { target: GLTF_ARRAY_BUFFER, byteStride: 4 * 4 },
  );

  const meshIndex = 0;
  nodes.push({
    name: options.name ?? 'character',
    mesh: meshIndex,
    skin: 0,
  });
  const meshNodeIndex = nodes.length - 1;

  // 动画：每个片段一个 glTF animation；线性插值（旋转为球面最短弧）。
  const animations = clips.map((clip) => {
    const animation = buildGltfAnimation(clip, skeleton, nodeIndexOf);
    const samplers: { input: number; output: number; interpolation: 'LINEAR' }[] = [];
    const channels: { sampler: number; target: { node: number; path: string } }[] = [];
    for (const channel of animation.channels) {
      const input = builder.addAccessor(
        channel.sampler.times,
        'SCALAR',
        GLTF_FLOAT,
        channel.sampler.times.length,
      );
      const output = builder.addAccessor(
        channel.sampler.values,
        channel.sampler.components === 4 ? 'VEC4' : 'VEC3',
        GLTF_FLOAT,
        channel.sampler.times.length,
      );
      const samplerIndex = samplers.length;
      samplers.push({ input, output, interpolation: 'LINEAR' });
      channels.push({
        sampler: samplerIndex,
        target: { node: channel.nodeIndex, path: channel.sampler.path },
      });
    }
    return { name: animation.name, samplers, channels };
  });

  builder.json.nodes = nodes;
  builder.json.skins = [
    {
      inverseBindMatrices: inverseBindAccessor,
      joints: skeleton.evalOrder.map((id) => nodeIndexOf.get(id)!),
    },
  ];
  builder.json.meshes = [
    {
      primitives: [
        {
          attributes: {
            POSITION: positionAccessor,
            JOINTS_0: jointsAccessor,
            WEIGHTS_0: weightsAccessor,
          },
          indices: indicesAccessor,
          mode: 4,
        },
      ],
    },
  ];
  if (animations.length > 0) builder.json.animations = animations;
  builder.json.scenes = [{ nodes: [nodeIndexOf.get(roots[0])!, meshNodeIndex] }];
  builder.json.scene = 0;

  return builder.build();
}

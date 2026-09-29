import {
  Quaternion,
} from 'three';
import type {
  AnimationClip,
  BoneTrack,
  Keyframe,
  Quat,
  Vec3,
} from './types.js';
import type { Skeleton } from './skeleton.js';
import { validateClip } from './clip.js';

export type GltfChannelPath = 'translation' | 'rotation' | 'scale';

export interface GltfSamplerData {
  readonly times: Float32Array;
  readonly values: Float32Array;
  readonly path: GltfChannelPath;
  /** VEC3 分量 3 / 旋转分量 4。 */
  readonly components: 3 | 4;
}

export interface GltfChannelData {
  /** 目标关节在 glTF 节点表中的索引。 */
  readonly nodeIndex: number;
  readonly path: GltfChannelPath;
  readonly sampler: GltfSamplerData;
}

export interface GltfAnimationData {
  readonly name: string;
  readonly duration: number;
  readonly channels: GltfChannelData[];
}

function isSameTime(a: number, b: number): boolean {
  return a === b;
}

/**
 * 在关键帧序列首尾补端值，确保 glTF 采样器严格覆盖 [0, duration]。
 * 库语义为两端外夹取端值；显式补帧后，任何符合 glTF 规范的加载器
 * （包括不自动外推的实现）都会延续同一端值。首/尾已有关键帧时不重复添加。
 * 返回全新数组，不修改输入。
 */
function extendKeys<T>(keys: readonly Keyframe<T>[], duration: number): Keyframe<T>[] {
  const out: Keyframe<T>[] = [];
  const first = keys[0];
  if (!isSameTime(first.time, 0)) {
    out.push({ time: 0, value: first.value });
  }
  out.push(...keys.map((k) => ({ time: k.time, value: k.value })));
  const last = keys[keys.length - 1];
  if (!isSameTime(last.time, duration)) {
    out.push({ time: duration, value: last.value });
  }
  return out;
}

function buildVec3Sampler(
  keys: readonly Keyframe<Vec3>[],
  duration: number,
  path: GltfChannelPath,
): GltfSamplerData {
  const extended = extendKeys(keys, duration);
  const times = new Float32Array(extended.length);
  const values = new Float32Array(extended.length * 3);
  for (let i = 0; i < extended.length; i++) {
    const { time, value } = extended[i];
    times[i] = time;
    values[i * 3] = value[0];
    values[i * 3 + 1] = value[1];
    values[i * 3 + 2] = value[2];
  }
  return { times, values, path, components: 3 };
}

/**
 * 旋转采样器：单位化关键帧并逐帧选取与前一帧点积非负的半球，+ * 使 glTF LINEAR（四元数球面插值）严格沿最短弧，与 slerpQuat 语义一致。
 */
function buildRotationSampler(
  keys: readonly Keyframe<Quat>[],
  duration: number,
): GltfSamplerData {
  const extended = extendKeys(keys, duration);
  const times = new Float32Array(extended.length);
  const values = new Float32Array(extended.length * 4);
  const q = new Quaternion();
  let prev = new Quaternion(0, 0, 0, 1);
  for (let i = 0; i < extended.length; i++) {
    const { time, value } = extended[i];
    q.set(value[0], value[1], value[2], value[3]).normalize();
    // 初始半球以绑定恒等旋转为参照即可：单段插值取最短弧，
    // 整体符号的连续性才是关键。
    if (i === 0) prev.set(q.x, q.y, q.z, q.w);
    if (q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
    times[i] = time;
    values[i * 4] = q.x;
    values[i * 4 + 1] = q.y;
    values[i * 4 + 2] = q.z;
    values[i * 4 + 3] = q.w;
    prev.set(q.x, q.y, q.z, q.w);
  }
  return { times, values, path: 'rotation', components: 4 };
}

/**
 * 把库的 AnimationClip 转换为 glTF 动画所需的通道数据。
 *
 * - 仅输出片段中存在的通道；缺失的平移/旋转/缩放由节点静态 TRS 绑定值表达，
 *   与库“缺失通道回退绑定值”的语义一致；
 * - 平移/缩放为线性插值，旋转为 glTF LINEAR（规范要求球面插值，即最短弧）；
 * - 采样器覆盖 [0, duration] 两端，首尾未覆盖时延续端值，终点保留末帧；
 * - 不叠加任何根运动世界位移：导出的是片段自身的局部轨道。
 * 不修改任何输入。
 */
export function buildGltfAnimation(
  clip: AnimationClip,
  skeleton: Skeleton,
  nodeIndexOf: ReadonlyMap<string, number>,
): GltfAnimationData {
  validateClip(clip, skeleton);
  const seen = new Set<string>();
  const channels: GltfChannelData[] = [];
  const pushTrack = (track: BoneTrack): void => {
    if (seen.has(track.boneId)) {
      throw new Error('片段 ' + clip.name + ' 存在重复轨道: ' + track.boneId);
    }
    seen.add(track.boneId);
    const nodeIndex = nodeIndexOf.get(track.boneId);
    if (nodeIndex === undefined) {
      throw new Error('片段 ' + clip.name + ' 引用了未知骨骼: ' + track.boneId);
    }
    if (track.translations && track.translations.length > 0) {
      channels.push({
        nodeIndex,
        path: 'translation',
        sampler: buildVec3Sampler(track.translations, clip.duration, 'translation'),
      });
    }
    if (track.rotations && track.rotations.length > 0) {
      channels.push({
        nodeIndex,
        path: 'rotation',
        sampler: buildRotationSampler(track.rotations, clip.duration),
      });
    }
    if (track.scales && track.scales.length > 0) {
      channels.push({
        nodeIndex,
        path: 'scale',
        sampler: buildVec3Sampler(track.scales, clip.duration, 'scale'),
      });
    }
  };
  for (const track of clip.tracks) pushTrack(track);
  return { name: clip.name, duration: clip.duration, channels };
}

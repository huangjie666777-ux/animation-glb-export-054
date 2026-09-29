import { validateClip } from './clip.js';
import type { Skeleton } from './skeleton.js';
import type { AnimationClip, Keyframe, Quat, Vec3 } from './types.js';

export type GltfAnimationPath = 'translation' | 'rotation' | 'scale';

export interface GltfAnimationChannel {
  readonly nodeIndex: number;
  readonly path: GltfAnimationPath;
  readonly times: Float32Array;
  readonly values: Float32Array;
}

export interface GltfAnimation {
  readonly name: string;
  readonly duration: number;
  readonly channels: GltfAnimationChannel[];
}

function expandKeys<T extends readonly number[]>(
  keys: readonly Keyframe<T>[],
  duration: number,
  valueSize: number,
): Pick<GltfAnimationChannel, 'times' | 'values'> {
  const prepend = keys[0].time > 0;
  const append = keys[keys.length - 1].time < duration;
  const count = keys.length + (prepend ? 1 : 0) + (append ? 1 : 0);
  const times = new Float32Array(count);
  const values = new Float32Array(count * valueSize);
  let out = 0;
  const write = (time: number, value: T): void => {
    times[out] = time;
    for (let i = 0; i < valueSize; i++) values[out * valueSize + i] = value[i];
    out++;
  };
  if (prepend) write(0, keys[0].value);
  for (const key of keys) write(key.time, key.value);
  if (append) write(duration, keys[keys.length - 1].value);
  return { times, values };
}

/** 把库片段转换为 glTF 节点局部 TRS 通道；不修改输入。 */
export function prepareGlbAnimations(
  skeleton: Skeleton,
  clips: readonly AnimationClip[],
): GltfAnimation[] {
  if (!Array.isArray(clips)) throw new Error('GLB clips 必须是数组');
  const nodeIndex = new Map(skeleton.evalOrder.map((id, index) => [id, index]));
  return clips.map((clip) => {
    validateClip(clip, skeleton);
    const channels: GltfAnimationChannel[] = [];
    for (const track of clip.tracks) {
      const node = nodeIndex.get(track.boneId)!;
      if (track.translations && track.translations.length > 0) {
        const data = expandKeys<Vec3>(track.translations, clip.duration, 3);
        channels.push({ nodeIndex: node, path: 'translation', ...data });
      }
      if (track.rotations && track.rotations.length > 0) {
        const data = expandKeys<Quat>(track.rotations, clip.duration, 4);
        channels.push({ nodeIndex: node, path: 'rotation', ...data });
      }
      if (track.scales && track.scales.length > 0) {
        const data = expandKeys<Vec3>(track.scales, clip.duration, 3);
        channels.push({ nodeIndex: node, path: 'scale', ...data });
      }
    }
    if (channels.length === 0) {
      const root = skeleton.evalOrder.find(
        (id) => skeleton.parentIndex.get(id) === null,
      )!;
      const bind = skeleton.bindLocalTransform(root);
      channels.push({
        nodeIndex: nodeIndex.get(root)!,
        path: 'translation',
        times: new Float32Array([0, clip.duration]),
        values: new Float32Array([
          bind.translation[0], bind.translation[1], bind.translation[2],
          bind.translation[0], bind.translation[1], bind.translation[2],
        ]),
      });
    }
    return { name: clip.name, duration: clip.duration, channels };
  });
}

import { Matrix4, Quaternion, Vector3 } from 'three';
import type {
  AnimationClip,
  LocalTransform,
  LoopMode,
  Quat,
  RigidTransform,
  Vec3,
} from './types.js';
import type { Skeleton } from './skeleton.js';
import { composeLocalMatrix } from './skeleton.js';
import { resolveClipTime, slerpQuat } from './pose.js';
import { sampleKeys, validateClip } from './clip.js';

const UNIT_SCALE_TOLERANCE = 1e-6;

const lerpVec3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function toVec3(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

function toQuat(q: Quaternion): Quat {
  return [q.x, q.y, q.z, q.w];
}

/** 由刚体变换组合矩阵（单位缩放）。 */
export function rigidToMatrix(t: RigidTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3(t.translation[0], t.translation[1], t.translation[2]),
    new Quaternion(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]),
    new Vector3(1, 1, 1),
  );
}

/** 从（仅含单位缩放的）矩阵分解出刚体变换。 */
export function matrixToRigid(m: Matrix4): RigidTransform {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  for (const v of [s.x, s.y, s.z]) {
    if (Math.abs(v - 1) > UNIT_SCALE_TOLERANCE) throw new Error('刚体变换仅支持单位缩放');
  }
  return { translation: toVec3(p), rotation: [q.x, q.y, q.z, q.w] };
}

/** 刚体复合 out = a × b（先施加 b 再施加 a）。 */
export function composeRigid(a: RigidTransform, b: RigidTransform): RigidTransform {
  return matrixToRigid(new Matrix4().multiplyMatrices(rigidToMatrix(a), rigidToMatrix(b)));
}

function assertUnitScale(s: Vec3, what: string): void {
  if (!s.every(Number.isFinite)) throw new Error(what + ' 缩放含非法数值');
  if (s.some((v) => Math.abs(v - 1) > UNIT_SCALE_TOLERANCE)) {
    throw new Error(what + ' 根运动仅支持单位根缩放');
  }
}

/**
 * 从基础片段提取指定顶层根骨骼的根运动。
 *
 * 根必须是无父级的顶层骨骼；根在绑定姿态与片段全部缩放关键帧中的缩放必须为
 * 单位值。根运动以片段起始（t=0）根变换 M0 为参考：任意时刻的相对运动为
 * M(t)·M0⁻¹，整圈运动为 M(duration)·M0⁻¹，按刚体矩阵顺序复合。
 */
export class RootMotion {
  readonly clip: AnimationClip;
  readonly rootBoneId: string;
  /** 片段起始根局部变换（姿态中根始终被钉在此变换）。 */
  readonly startLocal: LocalTransform;

  constructor(clip: AnimationClip, skeleton: Skeleton, rootBoneId: string) {
    validateClip(clip, skeleton);
    if (!skeleton.hasBone(rootBoneId)) throw new Error('根运动引用了未知骨骼: ' + rootBoneId);
    if (skeleton.parentIndex.get(rootBoneId) !== null) {
      throw new Error('根运动根骨骼必须是无父级的顶层根: ' + rootBoneId);
    }
    const bind = skeleton.bindLocalTransform(rootBoneId);
    assertUnitScale(bind.scale, '骨骼 ' + rootBoneId + ' 绑定');
    const track = clip.tracks.find((tr) => tr.boneId === rootBoneId);
    for (const k of track?.scales ?? []) assertUnitScale(k.value, '片段 ' + clip.name + ' 骨骼 ' + rootBoneId);

    this.clip = clip;
    this.rootBoneId = rootBoneId;
    this.startLocal = { translation: bind.translation, rotation: bind.rotation, scale: [1, 1, 1] };
    if (track) {
      const t0 = sampleKeys(track.translations ?? [], 0, lerpVec3);
      const r0 = sampleKeys(track.rotations ?? [], 0, slerpQuat);
      if (t0) this.startLocal = { ...this.startLocal, translation: t0 };
      if (r0) this.startLocal = { ...this.startLocal, rotation: r0 };
    }
  }

  /** 采样根在片段时间处的局部刚体变换（缺失通道回退到片段起始值）。 */
  sampleRootLocal(time: number, loop: LoopMode): LocalTransform {
    const t = resolveClipTime(time, this.clip.duration, loop);
    const track = this.clip.tracks.find((tr) => tr.boneId === this.rootBoneId);
    return {
      translation: (track && sampleKeys(track.translations ?? [], t, lerpVec3)) ?? this.startLocal.translation,
      rotation: (track && sampleKeys(track.rotations ?? [], t, slerpQuat)) ?? this.startLocal.rotation,
      scale: [1, 1, 1],
    };
  }

  /** 片段内时间 t 处相对片段起始的刚体运动 M(t)·M0⁻¹。 */
 deltaAt(time: number, loop: LoopMode): RigidTransform {
    const start = composeLocalMatrix(
      this.startLocal.translation,
      this.startLocal.rotation,
      [1, 1, 1],
    );
    const local = this.sampleRootLocal(time, loop);
    const current = composeLocalMatrix(local.translation, local.rotation, [1, 1, 1]);
    return matrixToRigid(new Matrix4().multiplyMatrices(current, start.clone().invert()));
  }

  /** 整圈（末帧相对首帧）刚体运动。 */
 cycleMotion(): RigidTransform {
    return this.deltaAt(this.clip.duration, 'once');
  }

  /**
   * 累计从片段起始经过 elapsed 秒后的总刚体运动。
   * loop 跨圈时为 K^n · D(r)：整圈运动按刚体顺序复合 n 次，
   * 再复合余段运动；once 在末帧夹取。分步推进与一次推进结果一致。
   */
  accumulate(elapsed: number, loop: LoopMode): {
    readonly motion: RigidTransform;
    readonly clipTime: number;
    readonly finished: boolean;
  } {
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new Error('播放时间必须为非负有限数: ' + String(elapsed));
    }
    const duration = this.clip.duration;
    if (loop === 'once') {
      const t = Math.min(elapsed, duration);
      return { motion: this.deltaAt(t, 'once'), clipTime: t, finished: elapsed >= duration };
    }
    const cycles = Math.floor(elapsed / duration);
    const remainder = elapsed % duration;
    let motion = this.deltaAt(remainder, 'once');
    const cycle = this.cycleMotion();
    for (let i = 0; i < cycles; i++) motion = composeRigid(cycle, motion);
    return { motion, clipTime: remainder, finished: false };
  }
}

export { toQuat, toVec3 };

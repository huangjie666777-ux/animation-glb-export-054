/** 三维向量，右手坐标系。 */
export type Vec3 = readonly [number, number, number];
/** 单位四元数，[x, y, z, w]。 */
export type Quat = readonly [number, number, number, number];

/** 单根骨骼的绑定姿态定义（输入允许乱序）。 */
export interface BoneSpec {
  /** 唯一骨骼 ID。 */
  readonly id: string;
  /** 父骨骼 ID；根骨骼为 null。 */
  readonly parentId: string | null;
  /** 绑定姿态局部平移。 */
  readonly translation: Vec3;
  /** 绑定姿态局部旋转（单位四元数）。 */
  readonly rotation: Quat;
  /** 绑定姿态局部缩放（各分量必须为正）。 */
  readonly scale: Vec3;
}

/** 关键帧。 */
export interface Keyframe<T> {
  /** 位于片段 [0, duration] 内，同一轨道内严格递增。 */
  readonly time: number;
  readonly value: T;
}

/** 单根骨骼的动画轨道；缺失的通道回退到绑定值。 */
export interface BoneTrack {
  readonly boneId: string;
  readonly translations?: readonly Keyframe<Vec3>[];
  readonly rotations?: readonly Keyframe<Quat>[];
  readonly scales?: readonly Keyframe<Vec3>[];
}

/** 动画片段。 */
export interface AnimationClip {
  readonly name: string;
  /** 正时长（秒）。 */
  readonly duration: number;
  readonly tracks: readonly BoneTrack[];
}

/** 播放模式：once 停在末帧；loop 按时长取模。 */
export type LoopMode = 'once' | 'loop';

/** 一个动画层的采样参数。 */
export interface LayerSample {
  readonly clip: AnimationClip;
  /** 非负采样时间（秒）。 */
  readonly time: number;
  readonly loop: LoopMode;
}

/** 覆盖层：在基础层之上按权重混合。 */
export interface OverlayLayer extends LayerSample {
  /** 覆盖强度，[0, 1]。 */
  readonly strength: number;
  /**
   * 骨骼遮罩权重（[0, 1]）。未指定的骨骼继承最近祖先的权重，
   * 根默认 0；显式 0 会屏蔽继承。
   */
  readonly mask?: Readonly<Record<string, number>>;
}

/** 单骨骼局部姿态。 */
export interface LocalTransform {
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

/** 每顶点蒙皮权重（至多 4 个骨骼影响）。 */
export interface SkinInfluence {
  readonly boneId: string;
  /** 非负权重。 */
  readonly weight: number;
}

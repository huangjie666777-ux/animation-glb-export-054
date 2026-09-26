import type { AnimationClip, BoneSpec, Quat, Vec3 } from '../src/index.js';

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
export const UNIT_SCALE: Vec3 = [1, 1, 1];

/** 绕 Z 轴旋转 angle 弧度的单位四元数。 */
export function quatZ(angle: number): Quat {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

/** 绕 Y 轴旋转。 */
export function quatY(angle: number): Quat {
  return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
}

/**
 * 简易人形骨架（右手坐标，Y 向上）：
 * hips(根) -> spine -> head；spine -> arm.L -> hand.L；spine -> arm.R -> hand.R；
 * hips -> leg.L；hips -> leg.R。
 * 故意乱序以验证拓扑排序。
 */
export function humanoidBones(): BoneSpec[] {
  const bone = (id: string, parentId: string | null, t: Vec3): BoneSpec => ({
    id,
    parentId,
    translation: t,
    rotation: IDENTITY_QUAT,
    scale: UNIT_SCALE,
  });
  return [
    bone('hand.R', 'arm.R', [0.3, 0, 0]),
    bone('leg.L', 'hips', [0.1, 0, 0]),
    bone('spine', 'hips', [0, 0.2, 0]),
    bone('hips', null, [0, 1, 0]),
    bone('arm.R', 'spine', [0.25, 0.15, 0]),
    bone('head', 'spine', [0, 0.3, 0]),
    bone('leg.R', 'hips', [-0.1, 0, 0]),
    bone('hand.L', 'arm.L', [0.3, 0, 0]),
    bone('arm.L', 'spine', [-0.25, 0.15, 0]),
  ];
}

/** 行走：hips 上下起伏，双腿绕 Z 反向摆动，循环。 */
export function walkClip(): AnimationClip {
  return {
    name: 'walk',
    duration: 1,
    tracks: [
      {
        boneId: 'hips',
        translations: [
          { time: 0, value: [0, 1, 0] },
          { time: 0.5, value: [0, 1.05, 0] },
          { time: 1, value: [0, 1, 0] },
        ],
      },
      {
        boneId: 'leg.L',
        rotations: [
          { time: 0, value: quatZ(0.5) },
          { time: 0.5, value: quatZ(-0.5) },
          { time: 1, value: quatZ(0.5) },
        ],
      },
      {
        boneId: 'leg.R',
        rotations: [
          { time: 0, value: quatZ(-0.5) },
          { time: 0.5, value: quatZ(0.5) },
          { time: 1, value: quatZ(-0.5) },
        ],
      },
    ],
  };
}

/** 挥手：仅右臂与右手绕 Z 摆动。 */
export function waveClip(): AnimationClip {
  return {
    name: 'wave',
    duration: 0.8,
    tracks: [
      {
        boneId: 'arm.R',
        rotations: [
          { time: 0, value: quatZ(1.2) },
          { time: 0.4, value: quatZ(1.6) },
          { time: 0.8, value: quatZ(1.2) },
        ],
      },
      {
        boneId: 'hand.R',
        rotations: [
          { time: 0, value: quatZ(0.4) },
          { time: 0.4, value: quatZ(-0.4) },
          { time: 0.8, value: quatZ(0.4) },
        ],
      },
    ],
  };
}

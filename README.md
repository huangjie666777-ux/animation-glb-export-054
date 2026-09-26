# Skeletal Animation 038

TypeScript 5.8 + Three.js 0.180 的可复用骨骼动画库：分层混合（基础层 + 遮罩覆盖层）与 CPU 线性蒙皮。

## 命令

- `npm run build` — 构建库到 `dist/`（含类型声明）
- `npm test` — 编译并运行全部单元测试
- `npm run example` — 运行“行走 + 局部挥手”示例，打印混合姿态与变形顶点

## 数据约定

- **坐标系**：右手坐标，Y 向上。向量 `[x, y, z]`，四元数 `[x, y, z, w]` 且必须为单位四元数。
- **骨骼**（`BoneSpec`）：唯一 `id`、`parentId`（根为 `null`）、绑定局部平移/旋转/正缩放。输入允许乱序；构建时校验重复 ID、未知父级、循环与非法数值（NaN/Infinity、非单位四元数、非正缩放）。
- **矩阵**：局部矩阵按 平移×旋转×缩放 组合；世界矩阵由父级向下累乘；逆绑定矩阵在构建时由绑定姿态求逆。
- **片段**（`AnimationClip`）：正时长；每条轨道按骨骼分别给出平移/旋转/缩放关键帧，时间严格递增且位于 `[0, duration]`。平移与缩放线性插值，旋转沿最短弧球面插值并保持单位四元数；轨道两端之外夹取端值；缺失轨道回退绑定值。
- **采样**：时间必须非负。`once` 停在末帧；`loop` 按时长取模。
- **分层混合**（`evaluatePose`）：一个基础层 + 一个可选覆盖层，各自有独立采样时间与循环模式。覆盖层骨骼权重 = `strength × 遮罩权重`（均 ∈ [0,1]）。遮罩未指定的骨骼继承最近祖先权重，根默认 0，显式 0 屏蔽继承。先混合局部姿态，再由父级累乘世界矩阵——不直接混合世界矩阵。
- **蒙皮**（`skinVertices`）：输入绑定姿态顶点与每顶点至多 4 个骨骼权重；非负权重归一化后做线性混合蒙皮，输出角色局部空间位置。零总权重顶点保持原位置；未知骨骼与负权重抛错。不修改任何输入，多角色实例互不共享状态。

## 快速上手

```ts
import { Skeleton, evaluatePose, skinVertices } from './dist/index.js';

const skeleton = new Skeleton(bones);            // BoneSpec[]，可乱序
const pose = evaluatePose(
  skeleton,
  { clip: walkClip, time: t, loop: 'loop' },                       // 基础层
  { clip: waveClip, time: t, loop: 'loop', strength: 1,
    mask: { 'arm.R': 1 } },                                        // 仅右臂覆盖
);
const positions = skinVertices(skeleton, bindVertices, skinWeights, pose.worldMatrices);
```

完整可运行示例见 `examples/walk-wave.ts`，测试用骨架/片段见 `test/helpers.ts`。

## 目录

- `src/types.ts` — 公共类型
- `src/skeleton.ts` — 骨架校验、绑定/世界/逆绑定矩阵
- `src/clip.ts` — 片段校验与关键帧采样
- `src/pose.ts` — 姿态采样、遮罩解析、分层混合
- `src/skinning.ts` — CPU 线性混合蒙皮
- `src/index.ts` — 统一导出入口

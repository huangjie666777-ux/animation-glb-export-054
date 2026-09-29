/** 本模块只负责 glTF 2.0 JSON / 二进制缓冲 / GLB 分块的规范编码。 */

export const GLTF_UNSIGNED_SHORT = 5121;
export const GLTF_UNSIGNED_INT = 5125;
export const GLTF_FLOAT = 5126;
export const GLTF_ARRAY_BUFFER = 34962;
export const GLTF_ELEMENT_ARRAY_BUFFER = 34963;

type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4';

export type TypedView = Float32Array | Uint32Array | Uint16Array;

interface GltfBufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: AccessorType;
  min?: readonly number[];
  max?: readonly number[];
  normalized?: boolean;
}

const COMPONENT_BYTES: Record<number, number> = {
  [GLTF_UNSIGNED_SHORT]: 2,
  [GLTF_UNSIGNED_INT]: 4,
  [GLTF_FLOAT]: 4,
};

const COMPONENT_COUNT: Record<AccessorType, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BIN_CHUNK = 0x004e4942; // 'BIN\0'

/** 累积二进制缓冲：所有视图按 4 字节对齐，天然满足组件对齐与分块对齐。 */
class BinaryHeap {
  private parts: Uint8Array[] = [];
  private offset = 0;

  get byteLength(): number {
    return this.offset;
  }

  add(data: TypedView): number {
    const required = Math.max(4, data.BYTES_PER_ELEMENT);
    while (this.offset % required !== 0) {
      this.parts.push(new Uint8Array([0]));
      this.offset += 1;
    }
    const byteOffset = this.offset;
    this.parts.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.offset += data.byteLength;
    return byteOffset;
  }

  toUint8Array(): Uint8Array {
    let length = this.offset;
    while (length % 4 !== 0) length += 1; // BIN 分块长度须为 4 的倍数
    const out = new Uint8Array(length);
    let pos = 0;
    for (const part of this.parts) {
      out.set(part, pos);
      pos += part.byteLength;
    }
    return out;
  }
}

/** glTF JSON 模型与缓冲的增量构建器；产出单一自包含 GLB。 */
export class GlbBuilder {
  readonly json: {
    asset: { version: '2.0'; generator?: string };
    scene?: number;
    scenes?: unknown[];
    nodes?: unknown[];
    skins?: unknown[];
    meshes?: unknown[];
    animations?: unknown[];
    accessors: GltfAccessor[];
    bufferViews: GltfBufferView[];
    buffers: { byteLength: number }[];
    [key: string]: unknown;
  };
  private readonly heap = new BinaryHeap();

  constructor() {
    this.json = {
      asset: { version: '2.0', generator: 'skeletal-animation-038' },
      accessors: [],
      bufferViews: [],
      buffers: [],
    };
  }

  /**
   * 追加一个访问器及其独立 bufferView，返回访问器索引。
   * 每个视图 4 字节对齐；顶点属性可带 byteStride。
   */
  addAccessor(
    data: TypedView,
    type: AccessorType,
    componentType: number,
    count: number,
    options: {
      target?: number;
      min?: readonly number[];
      max?: readonly number[];
      normalized?: boolean;
      byteStride?: number;
    } = {},
  ): number {
    const componentCount = COMPONENT_COUNT[type];
    const expected = count * componentCount * COMPONENT_BYTES[componentType];
    if (data.byteLength !== expected) {
      throw new Error('访问器数据长度不匹配: 期望 ' + expected + ' 实际 ' + data.byteLength);
    }
    const byteOffset = this.heap.add(data);
    const bufferView: GltfBufferView = {
      buffer: 0,
      byteOffset,
      byteLength: data.byteLength,
    };
    if (options.target !== undefined) bufferView.target = options.target;
    if (options.byteStride !== undefined) bufferView.byteStride = options.byteStride;
    const bufferViewIndex = this.json.bufferViews.length;
    this.json.bufferViews.push(bufferView);
    const accessor: GltfAccessor = {
      bufferView: bufferViewIndex,
      componentType,
      count,
      type,
    };
    if (options.min !== undefined) accessor.min = options.min;
    if (options.max !== undefined) accessor.max = options.max;
    if (options.normalized !== undefined) accessor.normalized = options.normalized;
    const accessorIndex = this.json.accessors.length;
    this.json.accessors.push(accessor);
    return accessorIndex;
  }

  /** 编码为自包含 GLB 字节（JSON + BIN 两个分块，无外部文件引用）。 */
  build(): ArrayBuffer {
    const bin = this.heap.toUint8Array();
    this.json.buffers = [{ byteLength: bin.byteLength }];

    const jsonText = JSON.stringify(this.json);
    const jsonBytes = new TextEncoder().encode(jsonText);
    const jsonPadded = padChunk(jsonBytes, 0x20);
    const binPadded = padChunk(bin, 0x00);

    const total = 12 + 8 + jsonPadded.byteLength + 8 + binPadded.byteLength;
    const out = new ArrayBuffer(total);
    const view = new DataView(out);
    const bytes = new Uint8Array(out);
    let offset = 0;
    view.setUint32(offset, GLB_MAGIC, true); offset += 4;
    view.setUint32(offset, GLB_VERSION, true); offset += 4;
    view.setUint32(offset, total, true); offset += 4;
    view.setUint32(offset, jsonPadded.byteLength, true); offset += 4;
    view.setUint32(offset, JSON_CHUNK, true); offset += 4;
    bytes.set(jsonPadded, offset); offset += jsonPadded.byteLength;
    view.setUint32(offset, binPadded.byteLength, true); offset += 4;
    view.setUint32(offset, BIN_CHUNK, true); offset += 4;
    bytes.set(binPadded, offset);
    return out;
  }
}

/** 分块长度必须为 4 的倍数；JSON 用空格填充，BIN 用零填充。 */
function padChunk(data: Uint8Array, fill: number): Uint8Array {
  const remainder = data.byteLength % 4;
  if (remainder === 0) return data;
  const padding = 4 - remainder;
  const out = new Uint8Array(data.byteLength + padding);
  out.set(data);
  out.fill(fill, data.byteLength);
  return out;
}

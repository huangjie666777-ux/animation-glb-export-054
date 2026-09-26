import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton } from '../src/index.js';
import { humanoidBones, IDENTITY_QUAT, UNIT_SCALE } from './helpers.js';

test('乱序输入可构建，求值顺序父先子后', () => {
  const sk = new Skeleton(humanoidBones());
  assert.equal(sk.boneIds.length, 9);
  const idx = new Map(sk.evalOrder.map((id, i) => [id, i]));
  for (const id of sk.boneIds) {
    const p = sk.parentIndex.get(id)!;
    if (p !== null) assert.ok(idx.get(p)! < idx.get(id)!, id + ' 应在父级之后');
  }
});

test('拒绝重复 ID / 未知父级 / 循环', () => {
  const base = humanoidBones();
  assert.throws(() => new Skeleton([...base, base[0]]), /重复骨骼 ID/);
  assert.throws(
    () => new Skeleton([{ id: 'a', parentId: 'ghost', translation: [0,0,0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE }]),
    /未知父级/,
  );
  assert.throws(
    () => new Skeleton([
      { id: 'a', parentId: 'b', translation: [0,0,0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
      { id: 'b', parentId: 'a', translation: [0,0,0], rotation: IDENTITY_QUAT, scale: UNIT_SCALE },
    ]),
    /循环/,
  );
});

test('拒绝非法数值：非单位四元数 / 非正缩放 / NaN', () => {
  const mk = (over: object) => [{
    id: 'a', parentId: null, translation: [0,0,0] as const,
    rotation: IDENTITY_QUAT, scale: UNIT_SCALE, ...over,
  }];
  assert.throws(() => new Skeleton(mk({ rotation: [0, 0, 0, 2] })), /单位四元数/);
  assert.throws(() => new Skeleton(mk({ scale: [1, -1, 1] })), /缩放/);
  assert.throws(() => new Skeleton(mk({ translation: [NaN, 0, 0] })), /非法数值/);
});

test('世界矩阵由父级累乘，逆绑定矩阵为其逆', () => {
  const sk = new Skeleton(humanoidBones());
  // hand.L 世界位置 = hips(0,1,0)+spine(0,0.2,0)+arm.L(-0.25,0.15,0)+hand.L(0.3,0,0)
  const m = sk.bindWorldMatrix('hand.L');
  const e = m.elements;
  assert.ok(Math.abs(e[12] - 0.05) < 1e-9);
  assert.ok(Math.abs(e[13] - 1.35) < 1e-9);
  assert.ok(Math.abs(e[14] - 0) < 1e-9);
  const inv = sk.inverseBindMatrix('hand.L');
  const product = m.clone().multiply(inv);
  for (let i = 0; i < 16; i++) {
    const expect = i % 5 === 0 ? 1 : 0;
    assert.ok(Math.abs(product.elements[i] - expect) < 1e-9);
  }
});

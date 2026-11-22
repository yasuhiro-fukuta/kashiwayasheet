// Lodgify アドオンの個数逆算 (gas/LodgifyAddons.gs resolveAddonQuantity) のテスト。
//  2026-11-22 社長決定：ほなみや値上げ。2026-12-01 0:00 JST 以降の注文は新料金、
//  それより前の予約は旧料金のまま → 旧・新どちらの金額でも正しく個数を出す。
//  実行: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function load() {
  const logs = [];
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/Config.gs'), 'utf8') + '\n;this.CONFIG = CONFIG;', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/LodgifyAddons.gs'), 'utf8'), ctx);
  ctx.numOrZero = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  ctx.dlog = (...a) => logs.push(a.join(' '));
  ctx.logs = logs;
  return ctx;
}

const q = (c, name, amount) => c.resolveAddonQuantity(name, 0, amount);

test('旧料金の予約 (11/30 までに受けた注文) の金額で個数が出る', () => {
  const c = load();
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 2', 6000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 3', 8000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Pork Hot Pot (Shabu-shabu) for 3', 11000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 2', 10000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 4', 18000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 3', 14000) }, { qty: 1, src: '逆算' });
});

test('新料金の予約 (12/1 0:00 以降に受けた注文) の金額で個数が出る', () => {
  const c = load();
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 2', 7000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 3', 10000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Pork Hot Pot (Shabu-shabu) for 2', 9000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Pork Chilled Pot (Rei-shabu) for 3', 13000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Vegan Gluten-free Hot Pot for 3', 13000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Vegan Gluten-free Chilled Pot for 2', 9000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 2', 11000) }, { qty: 1, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 4', 21000) }, { qty: 1, src: '逆算' });
});

test('朝食は据え置き ¥1,500 × 人数', () => {
  const c = load();
  assert.deepEqual({ ...q(c, 'Breakfast - Ochazuke risotto and Miso soup with pickles for 1', 4500) }, { qty: 3, src: '逆算' });
});

test('2セット注文も旧・新どちらでも出る', () => {
  const c = load();
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 2', 12000) }, { qty: 2, src: '逆算' });
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 2', 14000) }, { qty: 2, src: '逆算' });
});

test('旧・新で個数が食い違う金額は黙って選ばず「不明」', () => {
  const c = load();
  // 42,000 = 6,000×7 = 7,000×6
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 2', 42000) }, { qty: 1, src: '不明' });
  assert.ok(c.logs.some(l => l.includes('候補7/6')));
});

test('どちらの単価にも合わない金額は「不明」', () => {
  const c = load();
  assert.deepEqual({ ...q(c, 'Dinner - Chicken Hot Pot for 2', 6500) }, { qty: 1, src: '不明' });
  assert.deepEqual({ ...q(c, 'Dinner - Something New for 2', 6000) }, { qty: 1, src: '不明' });
});

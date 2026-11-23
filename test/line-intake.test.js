// LINE通知の受け口 (gas/LineIntake.gs) のテスト。
//  実行: node --test test/
//  GAS のサービス (Utilities・PropertiesService・CacheService・SpreadsheetApp) をスタブして叩く。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KEY = 'line-test-key-0123456789abcdef';

function makeStubs() {
  const props = {};
  const cache = {};
  const rows = [['受信日時', '送信者名', 'トーク名', '本文', '処理状態', '社長室メモ']];
  const sheet = {
    getLastRow: () => rows.length,
    appendRow: r => rows.push(Array.from(r)),
    getRange: (r, c, nr, nc) => ({
      getDisplayValues: () => rows.slice(r - 1, r - 1 + (nr || 1)).map(x => x.slice(c - 1, c - 1 + (nc || 1)).map(v => String(v === undefined ? '' : v))),
      getDisplayValue: () => String(rows[r - 1][c - 1] || ''),
      setValue: v => { rows[r - 1][c - 1] = v; return { setFontWeight: () => {} }; },
      getNote: () => 'x',
      setNote: () => {},
    }),
    setColumnWidth: () => {},
  };
  return {
    rows, props,
    stubs: {
      Utilities: {
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
        formatDate: () => '11/23 17:00',
      },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: k => { delete props[k]; },
      }) },
      CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
      SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
      ensureLedgerSheet_: () => sheet,
      nowJst_: () => '2026-11-23 17:00',
      CONFIG: { TZ: 'Asia/Tokyo' },
    },
  };
}

function load() {
  const s = makeStubs();
  const ctx = Object.assign({ console }, s.stubs);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/LineIntake.gs'), 'utf8'), ctx);
  return Object.assign(s, { c: ctx });
}

const post = (params, body) => ({ parameter: Object.assign({ src: 'line' }, params), postData: { contents: body || '' } });

test('JSON とフォームのどちらも読める', () => {
  const { c } = load();
  const a = c.lineParseInput_({}, JSON.stringify({ title: 'YukA', text: '灯油が半分です' }));
  assert.equal(a.title, 'YukA'); assert.equal(a.text, '灯油が半分です');
  const b = c.lineParseInput_({ title: '理恵', text: '明日休みます' }, 'title=x');
  assert.equal(b.title, '理恵'); assert.equal(b.text, '明日休みます');
});

test('1対1とグループの見分け（本文は元のまま残す）', () => {
  const { c } = load();
  const one = c.lineSplit_({ title: 'YukA', text: 'パンの在庫がありません', sub: '' });
  assert.deepEqual({ ...one }, { talk: 'YukA', sender: 'YukA', body: 'パンの在庫がありません' });
  const grp = c.lineSplit_({ title: '柏屋清掃', text: 'YukA: ごみ袋の置き場所', sub: '' });
  assert.equal(grp.talk, '柏屋清掃'); assert.equal(grp.sender, 'YukA'); assert.equal(grp.body, 'YukA: ごみ袋の置き場所');
  const sub = c.lineSplit_({ title: 'YukA', text: 'ごみ袋', sub: '柏屋清掃' });
  assert.equal(sub.talk, '柏屋清掃'); assert.equal(sub.sender, 'YukA');
  const url = c.lineSplit_({ title: 'ほなみや', text: 'https://example.com/a', sub: '' });
  assert.equal(url.sender, 'ほなみや');
});

test('まとめ通知・LINE以外は入れない', () => {
  const { c } = load();
  assert.equal(c.lineNoiseReason_({ title: 'LINE', text: '3件の新着メッセージがあります' }), 'まとめ通知');
  assert.equal(c.lineNoiseReason_({ title: 'YukA', text: '' }), '本文なし');
  assert.equal(c.lineNoiseReason_({ title: 'x', text: 'y', app: 'WhatsApp Business' }), 'LINE以外のアプリ');
  assert.equal(c.lineNoiseReason_({ title: 'YukA', text: 'こんにちは', app: 'LINE' }), '');
});

test('鍵が無い・違うと入れない', () => {
  const t = load();
  assert.equal(t.c.lineIntake_(post({ key: KEY }, '{"title":"a","text":"b"}')).error, 'line intake off');
  t.c.lineSetup_({ key: KEY });
  assert.equal(t.c.lineIntake_(post({ key: 'wrong' }, '{"title":"a","text":"b"}')).error, 'unauthorized');
  assert.equal(t.rows.length, 1);
  assert.ok(!JSON.stringify(t.props).includes(KEY), '鍵の本体を保存しない');
});

test('受けて1行足す・30分以内の同じ通知は足さない・一覧と状態変更', () => {
  const t = load();
  t.c.lineSetup_({ key: KEY });
  const r1 = t.c.lineIntake_(post({ key: KEY }, JSON.stringify({ title: 'YukA', text: '灯油の足し方を教えて', app: 'LINE' })));
  assert.equal(r1.added, 1);
  assert.deepEqual(t.rows[1], ['2026-11-23 17:00', 'YukA', 'YukA', '灯油の足し方を教えて', '未処理', '']);
  assert.equal(t.c.lineIntake_(post({ key: KEY }, JSON.stringify({ title: 'YukA', text: '灯油の足し方を教えて' }))).skipped, '重複');
  assert.equal(t.c.lineIntake_(post({ key: KEY, title: '理恵', text: '火曜OKです' })).added, 1);
  const L = t.c.lineList_({});
  assert.equal(L.count, 2); assert.equal(L.rows[0].sender, '理恵');
  assert.equal(t.c.lineStatus_().unprocessed, 2);
  t.c.lineSetStatus_({ row: 2, status: '済', memo: '灯油の手順を返信' });
  assert.equal(t.rows[1][4], '済'); assert.match(t.rows[1][5], /灯油の手順を返信/);
  assert.equal(t.c.lineStatus_().unprocessed, 1);
  assert.throws(() => t.c.lineSetStatus_({ row: 2, status: '完了' }));
  t.c.lineOff_();
  assert.equal(t.c.lineIntake_(post({ key: KEY }, '{"title":"a","text":"b"}')).error, 'line intake off');
});

// 依頼箱の即時起動 (gas/IraiWatch.gs) のテスト。
//  実行: node --test test/
//  Apps Script は手元で動かないので、SPEC.md 15.4 と同じく node の vm に
//  Config.gs と IraiWatch.gs を読み込み、GAS のサービスをスタブして叩く。
//  test/ は clasp の rootDir (gas/) の外なので Apps Script には送られない。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'sk-ant-oat-TEST-SECRET-123';

function load(stubs) {
  const ctx = Object.assign({ console }, stubs || {});
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/Config.gs'), 'utf8') + '\n;this.CONFIG = CONFIG;', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/IraiWatch.gs'), 'utf8'), ctx);
  return ctx;
}

const JST = s => Date.parse(s + '+09:00');
const NOW = JST('2026-11-21T10:00:00');

// ---------------- 純粋関数 ----------------
test('受付日時の読み取り', () => {
  const c = load();
  assert.equal(c.iraiParseReceived_('2026-11-21 09:30'), JST('2026-11-21T09:30:00'));
  assert.equal(c.iraiParseReceived_('2026/11/21 9:30'), JST('2026-11-21T09:30:00'));
  assert.equal(c.iraiParseReceived_(new Date(NOW)), NOW);
  assert.equal(c.iraiParseReceived_(''), null);
  assert.equal(c.iraiParseReceived_('きのう'), null);
});

test('未着手が無ければ撃たない', () => {
  const c = load();
  const p = c.iraiPlan_([['2026-11-21 09:00', 'コピー', 'x', '完了', 'url', '']], NOW, {}, c.CONFIG.IRAI);
  assert.equal(p.action, 'none');
  assert.deepEqual([...p.pending], []);
});

test('未着手の行を選ぶ (行番号はシートの番号)', () => {
  const c = load();
  const rows = [
    ['2026-11-20 19:30', 'PDF結合', 'a', '完了', 'url', ''],
    ['2026-11-21 09:50', 'コピー', 'b', '未着手', '', ''],
    ['2026-11-21 09:55', '調べもの', 'c', ' 未着手 ', '', ''],
  ];
  const p = c.iraiPlan_(rows, NOW, {}, c.CONFIG.IRAI);
  assert.equal(p.action, 'fire');
  assert.deepEqual([...p.pending], [3, 4]);
  assert.deepEqual([...p.targets.map(t => t.row)], [3, 4]);
});

test('受付から30分以内の「実行中」があれば撃たない／30分を過ぎたら撃つ', () => {
  const c = load();
  const I = c.CONFIG.IRAI;
  const run = recv => [[recv, 'x', 'x', '実行中', '', ''], ['2026-11-21 09:59', 'x', 'y', '未着手', '', '']];
  assert.equal(c.iraiPlan_(run('2026-11-21 09:40'), NOW, {}, I).action, 'skip-running');
  assert.equal(c.iraiPlan_(run('2026-11-21 09:30'), NOW, {}, I).action, 'skip-running'); // ちょうど30分
  assert.equal(c.iraiPlan_(run('2026-11-21 09:29'), NOW, {}, I).action, 'fire');
  assert.equal(c.iraiPlan_(run('読めない'), NOW, {}, I).action, 'fire');                 // 読めない受付は止めない
});

test('撃った行は二度撃たない／同じ行番号でも受付が違えば撃つ', () => {
  const c = load();
  const I = c.CONFIG.IRAI;
  const rows = [['2026-11-21 09:50', 'x', 'b', '未着手', '', '']];
  const recv = c.iraiRecvKey_('2026-11-21 09:50');
  const fired = { fires: [{ at: NOW - 60000, rows: [{ row: 2, recv }], session: 's' }] };
  assert.equal(c.iraiPlan_(rows, NOW, fired, I).action, 'skip-already');

  // 新しい行が増えたら、その行だけを対象に撃つ
  const rows2 = rows.concat([['2026-11-21 09:58', 'x', 'c', '未着手', '', '']]);
  const p2 = c.iraiPlan_(rows2, NOW, fired, I);
  assert.equal(p2.action, 'fire');
  assert.deepEqual([...p2.targets.map(t => t.row)], [3]);
  assert.deepEqual([...p2.pending], [2, 3]);   // 本文の行番号は未着手すべて

  // 行が消えて番号がずれ、別の依頼が2行目に来た
  const rows3 = [['2026-11-21 09:59', 'x', 'z', '未着手', '', '']];
  assert.equal(c.iraiPlan_(rows3, NOW, fired, I).action, 'fire');
});

test('1日60回で止まる (日本時間の日付で数える)', () => {
  const c = load();
  const I = c.CONFIG.IRAI;
  const rows = [['2026-11-21 09:59', 'x', 'y', '未着手', '', '']];
  const today = [];
  for (let i = 0; i < 60; i++) today.push({ at: JST('2026-11-21T00:10:00') + i * 60000, rows: [{ row: 100 + i, recv: 'r' }], session: '' });
  assert.equal(c.iraiFiresToday_({ fires: today }, NOW), 60);
  assert.equal(c.iraiPlan_(rows, NOW, { fires: today }, I).action, 'skip-cap');

  // 59回なら撃つ
  assert.equal(c.iraiPlan_(rows, NOW, { fires: today.slice(1) }, I).action, 'fire');

  // 前日 (日本時間 11/20 23:59) の分は数えない。UTC では 11/20 14:59 なので日付の境目を確かめる
  const yesterday = today.map(f => Object.assign({}, f, { at: JST('2026-11-20T23:59:00') }));
  assert.equal(c.iraiFiresToday_({ fires: yesterday }, NOW), 0);
  // 日本時間 0:05 は今日 (UTC だと前日 15:05)
  assert.equal(c.iraiFiresToday_({ fires: [{ at: JST('2026-11-21T00:05:00'), rows: [] }] }, NOW), 1);
});

test('7日より古い記録を捨てる', () => {
  const c = load();
  const day = 24 * 3600 * 1000;
  const s = { fires: [
    { at: NOW - 8 * day, rows: [{ row: 2, recv: 'a' }] },
    { at: NOW - 7 * day, rows: [{ row: 3, recv: 'b' }] },
    { at: NOW - 1 * day, rows: [{ row: 4, recv: 'c' }] },
  ] };
  const out = c.iraiPruneFired_(s, NOW, 7);
  assert.deepEqual([...out.fires.map(f => f.rows[0].row)], [3, 4]);
  assert.deepEqual(c.iraiPruneFired_('壊れた値', NOW, 7).fires.length, 0);
});

test('メモは既存を消さずに追記', () => {
  const c = load();
  assert.equal(c.iraiAppendMemo_('', '10:05'), '自動起動 10:05');
  assert.equal(c.iraiAppendMemo_('急ぎ', '10:05'), '急ぎ / 自動起動 10:05');
});

test('本文は固定文＋行番号だけ', () => {
  const c = load();
  assert.equal(c.iraiFireText_([3, 4]), '依頼箱に未着手の依頼があります（行番号: 3, 4）。指示文どおり依頼箱を処理してください。');
});

// ---------------- GAS 側 (スタブ) ----------------
function gasStubs(opts) {
  const props = Object.assign({}, opts.props || {});
  const logs = [];
  const fetches = [];
  const triggers = (opts.triggers || []).map(h => ({ getHandlerFunction: () => h }));
  const sheetRows = opts.rows.map(r => r.slice());
  const sheet = {
    getLastRow: () => sheetRows.length + 1,
    getRange: (row, col, nr, nc) => {
      if (nr !== undefined) return { getValues: () => sheetRows.slice(row - 2, row - 2 + nr).map(r => r.slice(col - 1, col - 1 + nc)) };
      return {
        getValue: () => sheetRows[row - 2][col - 1],
        setValue: v => { sheetRows[row - 2][col - 1] = v; },
      };
    },
  };
  const stubs = {
    Logger: { log: m => logs.push(String(m)) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
    }) },
    LockService: { getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: {
      openById: id => { if (id !== 'SHEET_ID_TEST_0123456789') throw new Error('no access'); return { getSheetByName: n => (n === '依頼' ? sheet : null) }; },
      flush: () => {},
    },
    UrlFetchApp: { fetch: (url, o) => { fetches.push({ url, o }); return opts.response; } },
    Utilities: { formatDate: (d, tz, f) => {
      const j = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
      return f === 'HH:mm' ? j.slice(11, 16) : j.slice(0, 16).replace('T', ' ');
    } },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: h => ({ timeBased: () => ({ everyMinutes: m => ({ create: () => { triggers.push({ getHandlerFunction: () => h, every: m }); } }) }) }),
    },
  };
  return { stubs, props, logs, fetches, sheetRows, triggers };
}

const okResponse = {
  getResponseCode: () => 200,
  getContentText: () => JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'cse_1', claude_code_session_url: 'https://claude.ai/code/session_x' }),
};

test('トークンが無ければ何もしない', () => {
  const g = gasStubs({ rows: [['2026-11-21 09:50', 'x', 'y', '未着手', '', '']] });
  const c = load(g.stubs);
  assert.equal(c.iraiWatch().action, 'no-token');
  assert.equal(g.fetches.length, 0);
});

test('撃つ → 記録・メモ追記、2回目は撃たない。トークンはログに出ない', () => {
  const g = gasStubs({
    props: { IRAI_FIRE_TOKEN: TOKEN, IRAI_SHEET_ID: 'SHEET_ID_TEST_0123456789' },
    rows: [['2026-11-21 09:50', 'x', 'y', '未着手', '', 'メモあり'], ['2026-11-21 09:00', 'x', 'z', '完了', 'u', '']],
    response: okResponse,
  });
  const c = load(g.stubs);
  const r = c.iraiWatch();
  assert.equal(r.action, 'fired');
  assert.equal(g.fetches.length, 1);
  const f = g.fetches[0];
  assert.equal(f.url, 'https://api.anthropic.com/v1/claude_code/routines/trig_01MbvsAj8hwqk6BXyWGxD6sA/fire');
  assert.equal(f.o.method, 'post');
  assert.equal(f.o.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.o.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(f.o.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(f.o.payload).text, '依頼箱に未着手の依頼があります（行番号: 2）。指示文どおり依頼箱を処理してください。');
  assert.match(g.sheetRows[0][5], /^メモあり \/ 自動起動 \d\d:\d\d$/);
  assert.equal(g.sheetRows[1][5], '');
  assert.equal(JSON.parse(g.props.IRAI_FIRED).fires.length, 1);
  assert.ok(g.logs.some(l => l.includes('session_x')));
  assert.ok(!g.logs.some(l => l.includes(TOKEN)));

  assert.equal(c.iraiWatch().action, 'skip-already');
  assert.equal(g.fetches.length, 1);
});

test('失敗したら記録せず、次の回に再試行', () => {
  const g = gasStubs({
    props: { IRAI_FIRE_TOKEN: TOKEN, IRAI_SHEET_ID: 'SHEET_ID_TEST_0123456789' },
    rows: [['2026-11-21 09:50', 'x', 'y', '未着手', '', '']],
    response: { getResponseCode: () => 429, getContentText: () => '{"error":"rate"}' },
  });
  const c = load(g.stubs);
  assert.equal(c.iraiWatch().action, 'fire-failed');
  assert.equal(JSON.parse(g.props.IRAI_FIRED).fires.length, 0);
  assert.equal(g.sheetRows[0][5], '');
  assert.equal(c.iraiWatch().action, 'fire-failed');
  assert.equal(g.fetches.length, 2);
  assert.ok(!g.logs.some(l => l.includes(TOKEN)));
});

test('irai.setup はトリガーを1本だけ作り、トークンを返さない。irai.off で消える。hourlySync は残る', () => {
  const g = gasStubs({ rows: [], triggers: ['hourlySync'] });
  const c = load(g.stubs);
  assert.throws(() => c.iraiSetup_({ fireToken: TOKEN }), /sheetId/);
  const r1 = c.iraiSetup_({ fireToken: TOKEN, sheetId: 'SHEET_ID_TEST_0123456789' });
  assert.equal(r1.trigger, 'created');
  assert.equal(r1.tokenSet, true);
  assert.equal(r1.routineTriggerId, 'trig_01MbvsAj8hwqk6BXyWGxD6sA');
  assert.ok(!JSON.stringify(r1).includes(TOKEN));
  assert.equal(g.triggers.filter(t => t.getHandlerFunction() === 'iraiWatch').length, 1);
  assert.equal(g.triggers.find(t => t.getHandlerFunction() === 'iraiWatch').every, 5);

  const r2 = c.iraiSetup_({});
  assert.equal(r2.trigger, 'exists');
  assert.equal(g.triggers.filter(t => t.getHandlerFunction() === 'iraiWatch').length, 1);
  assert.ok(!JSON.stringify(c.iraiStatus_()).includes(TOKEN));

  assert.throws(() => c.iraiSetup_({ triggerId: 'bad id' }), /triggerId/);
  assert.deepEqual(JSON.parse(JSON.stringify(c.iraiOff_())), { ok: true, removed: 1 });
  assert.equal(c.iraiStatus_().triggerActive, false);
  assert.deepEqual(g.triggers.map(t => t.getHandlerFunction()), ['hourlySync']);
});

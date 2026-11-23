// スタッフ連絡LINE (gas/StaffLine.gs) の純粋関数と Webhook のテスト。
//  実行: node --test test/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UID = 'U' + 'a'.repeat(32);

function load(stubs) {
  const ctx = Object.assign({ console }, stubs || {});
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/StaffLine.gs'), 'utf8') + '\n;this.STAFF_LINE_ = STAFF_LINE_;', ctx);
  return ctx;
}

test('合言葉の照合', () => {
  const c = load();
  assert.equal(c.staffLineKeyOk_('abc', 'abc'), true);
  assert.equal(c.staffLineKeyOk_('abd', 'abc'), false);
  assert.equal(c.staffLineKeyOk_('', ''), false);
  assert.equal(c.staffLineKeyOk_(undefined, 'abc'), false);
  assert.equal(c.staffLineKeyOk_('ab', 'abc'), false);
});

test('テキストのイベント → 1行', () => {
  const c = load();
  const rec = c.staffLineEventToRecord_({
    type: 'message', timestamp: Date.parse('2026-11-23T07:00:00Z'), webhookEventId: 'E1', replyToken: 'R1',
    source: { type: 'user', userId: UID }, message: { type: 'text', id: '123', text: '灯油の足し方は？' },
    deliveryContext: { isRedelivery: false },
  });
  const row = c.staffLineRecordToRow_(rec, 'ゆか', 'YukA');
  assert.equal(row.length, 17);
  assert.equal(row[0], '2026-11-23 16:00:00');
  assert.equal(row[2], 'ゆか');
  assert.equal(row[4], UID);
  assert.equal(row[5], 'text');
  assert.equal(row[6], '灯油の足し方は？');
  assert.equal(row[7], '123');
  assert.equal(row[8], 'E1');
  assert.equal(row[9], '未読');
});

test('式に見える本文はエスケープ・画像は種類だけ・follow は対応不要', () => {
  const c = load();
  const t = c.staffLineEventToRecord_({ type: 'message', source: { userId: UID }, message: { type: 'text', id: '1', text: '=1+1' } });
  assert.equal(c.staffLineRecordToRow_(t)[6], "'=1+1");
  const img = c.staffLineEventToRecord_({ type: 'message', source: { userId: UID }, message: { type: 'image', id: '9' } });
  assert.match(img.text, /画像/);
  const f = c.staffLineEventToRecord_({ type: 'follow', source: { userId: UID } });
  assert.equal(c.staffLineRecordToRow_(f)[9], '対応不要');
  assert.equal(c.staffLineEventToRecord_({ type: 'unsend', source: { userId: UID } }), null);
});

test('自動受付返信は設定ONかつ30分に1回', () => {
  const c = load();
  const rec = { event: 'message', replyToken: 'R', userId: UID, groupId: '' };
  const now = 1e12;
  assert.equal(c.staffLineShouldAck_(rec, false, {}, now), false);
  assert.equal(c.staffLineShouldAck_(rec, true, {}, now), true);
  assert.equal(c.staffLineShouldAck_(rec, true, { [UID]: now - 10 * 60e3 }, now), false);
  assert.equal(c.staffLineShouldAck_(rec, true, { [UID]: now - 31 * 60e3 }, now), true);
  assert.equal(c.staffLineShouldAck_(Object.assign({}, rec, { groupId: 'C1' }), true, {}, now), false);
});

test('送信の入力チェック（社長の「あ」の記録が無いと送らない）', () => {
  const c = load();
  assert.equal(c.staffLineSendProblem_(5, 'こんにちは', '社長あ 2026-11-23 18:00', '承認待ち', false), '');
  assert.match(c.staffLineSendProblem_(5, 'こんにちは', '', '承認待ち', false), /approval/);
  assert.match(c.staffLineSendProblem_(5, '  ', '社長あ 2026-11-23 18:00', '', false), /空/);
  assert.match(c.staffLineSendProblem_(1, 'x', '社長あ 2026-11-23 18:00', '', false), /row/);
  assert.match(c.staffLineSendProblem_(5, 'x', '社長あ 2026-11-23 18:00', '送信済', false), /送信済/);
  assert.equal(c.staffLineSendProblem_(5, 'x', '社長あ 2026-11-23 18:00', '送信済', true), '');
});

test('Webhook：合言葉違いは何も書かない／正しければ1行・再送は1回だけ', () => {
  const props = { STAFF_LINE_WEBHOOK_KEY: 'K'.repeat(48) };
  const appended = { in: [], roster: [] };
  const mkSheet = (name) => ({
    _rows: [],
    getLastRow() { return 1 + this._rows.length; },
    getRange(r, col, n, w) {
      const self = this;
      return {
        getValues() { return self._rows.slice(r - 2, r - 2 + n).map(x => x.slice(col - 1, col - 1 + (w || 1))); },
        setValues() { return this; }, setFontWeight() { return this; }, setValue() { return this; },
      };
    },
    appendRow(row) { this._rows.push(row); (name === 'スタッフ連絡_受信' ? appended.in : appended.roster).push(row); },
    setFrozenRows() {},
  });
  const sheets = {};
  const c = load({
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    ContentService: { createTextOutput: t => ({ text: t }) },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n)) }) },
    UrlFetchApp: { fetch: () => { throw new Error('ネットには出ない（トークン無し）'); } },
  });
  const ev = { type: 'message', timestamp: 0, webhookEventId: 'E9', source: { userId: UID }, message: { type: 'text', id: '1', text: 'パンの在庫なし' } };
  const post = (k) => ({ parameter: { src: 'staffline', k }, postData: { contents: JSON.stringify({ events: [ev] }) } });

  c.staffLineHandleWebhook_(post('wrong'));
  assert.equal(appended.in.length, 0);
  c.staffLineHandleWebhook_(post('K'.repeat(48)));
  assert.equal(appended.in.length, 1);
  assert.equal(appended.in[0][6], 'パンの在庫なし');
  assert.equal(appended.roster.length, 1);
  c.staffLineHandleWebhook_(post('K'.repeat(48)));  // 再送
  assert.equal(appended.in.length, 1);
});

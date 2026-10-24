/**
 * ============================================================
 *  DmLedger.gs - DM台帳・お客様台帳・返信ルール  v1.00 (2026-10-24 社長決定)
 * ============================================================
 *  ゲストとのやり取りを、Googleドキュメントの「問い合わせ台帳」から
 *  このブックの3枚のシートへ引っ越す。
 *
 *   DM台帳      … 1メッセージ＝1行（受信も返信も）。名前・連絡先キー・日付で絞って読む。
 *                  受信は自動返信GAS（受信箱）が自動で足す。返信は送った側が足す。
 *   お客様台帳  … 1お客様＝1行。サービス・実施日・決まったこと・未解決・経緯（要約）。
 *                  連絡先キー（lodgify:B22473883 ／ wa:61404192752 ／ ig:xxx ／ name:Jacinta）で更新する。
 *   返信ルール  … 返信方針・よくある質問の前例・まだわかっていないこと・シートの読み方。
 *
 *  書き込み API（WriteApi.gs の doPost から呼ぶ）:
 *   dm.append       rows: [{name, sender, date:'yyyy-MM-dd', time:'HH:mm', summary, full,
 *                          key, channel, dir:'受'|'返', status?, inboxId?, source?}]
 *                   ・source が同じ行が既にあれば足さない（取り込みの二重防止）
 *                   ・dir='返' を足すと、同じキーの「未返信」の受信行を「返信済み」にする
 *   dm.setStatus    match: {key? , inboxId?}  status
 *   dm.find         {key?, name?, since?, until?, dir?, status?, limit?, fullMax?}
 *   guest.upsert    rows: [{key, name?, aliases?, state?, date?, service?, decided?, open?, log?,
 *                          decidedAppend?, openAppend?, logAppend?}]
 *   guest.find      {key?, name?, state?, from?, to?}
 *   rule.append     rows: [{kind, date?, text}]
 *   rule.list       {kind?}
 *  ★人が直接書き込んでもよいシート。GAS は追記・更新だけで、行を消したり並べ替えたりしない。
 * ============================================================
 */

const DM_SHEET_ = 'DM台帳';
const DM_HEADER_ = ['対象の名前', '送信者', '年月日', '時分秒', 'メッセージ要約', 'メッセージ全文',
  '連絡先キー', '媒体', '方向', '状態', '受信箱ID', '出典', '記入日時'];
const DM_COL_ = {}; DM_HEADER_.forEach((h, i) => DM_COL_[h] = i);

const GUEST_SHEET_ = 'お客様台帳';
const GUEST_HEADER_ = ['連絡先キー', '対象の名前', '別名・ほかの連絡先', '区分', '実施日', 'サービス',
  '決まったこと', '未解決', '経緯（要約）', '更新日時'];
const GUEST_COL_ = {}; GUEST_HEADER_.forEach((h, i) => GUEST_COL_[h] = i);

const RULE_SHEET_ = '返信ルール';
const RULE_HEADER_ = ['区分', '日付', '内容', '記入日時'];

// ---------- シートの用意 ----------
function ensureLedgerSheet_(name, header, widths) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.setFrozenRows(1);
  }
  const cur = sh.getRange(1, 1, 1, header.length).getDisplayValues()[0];
  header.forEach((h, i) => {
    if (String(cur[i] || '').trim() !== h) sh.getRange(1, i + 1).setValue(h).setFontWeight('bold');
  });
  if (sh.getMaxColumns() < header.length) sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  if (widths) widths.forEach((w, i) => { if (w) sh.setColumnWidth(i + 1, w); });
  return sh;
}
function dmSheet_() { return ensureLedgerSheet_(DM_SHEET_, DM_HEADER_, null); }
function guestSheet_() { return ensureLedgerSheet_(GUEST_SHEET_, GUEST_HEADER_, [170, 170, 200, 70, 110, 220, 320, 280, 400, 120]); }
function ruleSheet_() { return ensureLedgerSheet_(RULE_SHEET_, RULE_HEADER_, [130, 100, 700, 120]); }

function sheetRows_(sh, width) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getDisplayValues();
}

/** 最後のデータ行（テーブル書式などで空行が残っていても、A列〜の実データで判定） */
function lastDataRow_(sh, width) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const vals = sh.getRange(2, 1, last - 1, width).getDisplayValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i].some(v => String(v).trim() !== '')) return i + 2;
  }
  return 1;
}

function normKey_(k) { return String(k || '').trim(); }
function normText_(s) { return String(s || '').toLowerCase().replace(/[\s’'`]/g, ''); }

// ---------- DM台帳 ----------
function writeApiDmAppend_(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows が空です');
  if (rows.length > 500) throw new Error('rows は1回500行まで');
  const sh = dmSheet_();
  const W = DM_HEADER_.length;
  const lastRow = lastDataRow_(sh, W);
  const existing = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, W).getDisplayValues() : [];
  const sources = new Set(existing.map(r => r[DM_COL_['出典']]).filter(Boolean));
  const now = nowJst_();
  const out = [];
  const repliedKeys = new Set();
  rows.forEach((r, i) => {
    const dir = String(r.dir || '').trim();
    if (dir !== '受' && dir !== '返') throw new Error(`rows[${i}].dir は 受 か 返`);
    const date = requireDate_(r.date, `rows[${i}].date`);
    const src = String(r.source || '').trim();
    if (src && sources.has(src)) return;
    if (src) sources.add(src);
    const key = normKey_(r.key);
    const full = String(r.full || '').slice(0, 45000);
    const summary = String(r.summary || '').trim() || full.replace(/\s+/g, ' ').slice(0, 120);
    const row = new Array(W).fill('');
    row[DM_COL_['対象の名前']] = String(r.name || '').trim();
    row[DM_COL_['送信者']] = String(r.sender || (dir === '返' ? '柏屋（Yakkun）' : r.name || '')).trim();
    row[DM_COL_['年月日']] = date;
    row[DM_COL_['時分秒']] = String(r.time || '').trim();
    row[DM_COL_['メッセージ要約']] = summary;
    row[DM_COL_['メッセージ全文']] = full;
    row[DM_COL_['連絡先キー']] = key;
    row[DM_COL_['媒体']] = String(r.channel || '').trim();
    row[DM_COL_['方向']] = dir;
    row[DM_COL_['状態']] = String(r.status || (dir === '受' ? '未返信' : '送信済み')).trim();
    row[DM_COL_['受信箱ID']] = r.inboxId === undefined || r.inboxId === null ? '' : String(r.inboxId);
    row[DM_COL_['出典']] = src;
    row[DM_COL_['記入日時']] = now;
    out.push(row);
    if (dir === '返' && key && !r.keepOpen) repliedKeys.add(key);
  });
  let first = null;
  if (out.length) {
    first = lastRow + 1;
    const rng = sh.getRange(first, 1, out.length, W);
    rng.setNumberFormat('@');
    rng.setValues(out);
  }
  // 返信したキーの「未返信」の受信行を「返信済み」に
  let closed = 0;
  if (repliedKeys.size) closed = dmCloseOpen_(sh, repliedKeys);
  SpreadsheetApp.flush();
  return { ok: true, sheet: DM_SHEET_, added: out.length, skipped: rows.length - out.length, firstRow: first, closed: closed };
}

function dmCloseOpen_(sh, keys) {
  const W = DM_HEADER_.length;
  const last = lastDataRow_(sh, W);
  if (last < 2) return 0;
  const vals = sh.getRange(2, 1, last - 1, W).getDisplayValues();
  let n = 0;
  vals.forEach((r, i) => {
    if (keys.has(r[DM_COL_['連絡先キー']]) && r[DM_COL_['方向']] === '受' && r[DM_COL_['状態']] === '未返信') {
      sh.getRange(i + 2, DM_COL_['状態'] + 1).setValue('返信済み');
      n++;
    }
  });
  return n;
}

function writeApiDmSetStatus_(match, status) {
  match = match || {};
  const st = String(status || '').trim();
  if (!st) throw new Error('status が必要です');
  const key = normKey_(match.key);
  const inboxId = match.inboxId === undefined ? '' : String(match.inboxId);
  if (!key && !inboxId) throw new Error('match.key か match.inboxId が必要です');
  const sh = dmSheet_();
  const W = DM_HEADER_.length;
  const last = lastDataRow_(sh, W);
  if (last < 2) return { ok: true, updated: 0 };
  const vals = sh.getRange(2, 1, last - 1, W).getDisplayValues();
  let n = 0;
  vals.forEach((r, i) => {
    const hit = inboxId ? r[DM_COL_['受信箱ID']] === inboxId : r[DM_COL_['連絡先キー']] === key;
    if (!hit) return;
    if (match.dir && r[DM_COL_['方向']] !== match.dir) return;
    if (match.onlyStatus && r[DM_COL_['状態']] !== match.onlyStatus) return;
    sh.getRange(i + 2, DM_COL_['状態'] + 1).setValue(st);
    n++;
  });
  return { ok: true, updated: n };
}

/** 名前・キー・期間で DM台帳を読む。名前はお客様台帳の名前・別名からキーも引く */
function writeApiDmFind_(q) {
  q = q || {};
  const sh = SpreadsheetApp.getActive().getSheetByName(DM_SHEET_);
  if (!sh) return { ok: true, rows: [] };
  const W = DM_HEADER_.length;
  const last = lastDataRow_(sh, W);
  if (last < 2) return { ok: true, rows: [] };
  const vals = sh.getRange(2, 1, last - 1, W).getDisplayValues();
  const keys = new Set();
  if (q.key) keys.add(normKey_(q.key));
  const name = q.name ? normText_(q.name) : '';
  if (name) guestKeysByName_(name).forEach(k => keys.add(k));
  const fullMax = Math.min(Number(q.fullMax) || 2000, 45000);
  const out = [];
  vals.forEach((r, i) => {
    const k = r[DM_COL_['連絡先キー']];
    if (q.key || name) {
      const byKey = k && keys.has(k);
      const byName = name && (normText_(r[DM_COL_['対象の名前']]).indexOf(name) >= 0 || normText_(r[DM_COL_['送信者']]).indexOf(name) >= 0);
      if (!byKey && !byName) return;
    }
    const d = r[DM_COL_['年月日']];
    if (q.since && d < q.since) return;
    if (q.until && d > q.until) return;
    if (q.dir && r[DM_COL_['方向']] !== q.dir) return;
    if (q.status && r[DM_COL_['状態']] !== q.status) return;
    const o = { row: i + 2 };
    DM_HEADER_.forEach((h, j) => { o[h] = r[j]; });
    if (o['メッセージ全文'].length > fullMax) o['メッセージ全文'] = o['メッセージ全文'].slice(0, fullMax) + '…';
    out.push(o);
  });
  out.sort((a, b) => (a['年月日'] + a['時分秒']) < (b['年月日'] + b['時分秒']) ? -1 : 1);
  const limit = Math.min(Number(q.limit) || 300, 2000);
  return { ok: true, total: out.length, rows: out.slice(-limit) };
}

// ---------- お客様台帳 ----------
function guestKeysByName_(nameNorm) {
  const sh = SpreadsheetApp.getActive().getSheetByName(GUEST_SHEET_);
  if (!sh) return [];
  const out = [];
  sheetRows_(sh, GUEST_HEADER_.length).forEach(r => {
    const hay = normText_(r[GUEST_COL_['対象の名前']] + ' ' + r[GUEST_COL_['別名・ほかの連絡先']] + ' ' + r[GUEST_COL_['連絡先キー']]);
    if (hay.indexOf(nameNorm) < 0) return;
    out.push(r[GUEST_COL_['連絡先キー']]);
    // 別名欄に書いたほかのキー（wa:… lodgify:… ig:… name:…）も含める
    (String(r[GUEST_COL_['別名・ほかの連絡先']]).match(/(?:lodgify|wa|ig|name):[^\s、,／\/]+/g) || []).forEach(k => out.push(k));
  });
  return out;
}

function writeApiGuestUpsert_(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows が空です');
  if (rows.length > 300) throw new Error('rows は1回300行まで');
  const sh = guestSheet_();
  const W = GUEST_HEADER_.length;
  const last = lastDataRow_(sh, W);
  const vals = last >= 2 ? sh.getRange(2, 1, last - 1, W).getDisplayValues() : [];
  const idx = {};
  vals.forEach((r, i) => { if (r[0]) idx[r[0]] = i; });
  const now = nowJst_();
  const fieldMap = { name: '対象の名前', aliases: '別名・ほかの連絡先', state: '区分', date: '実施日',
    service: 'サービス', decided: '決まったこと', open: '未解決', log: '経緯（要約）' };
  const appendMap = { decidedAppend: '決まったこと', openAppend: '未解決', logAppend: '経緯（要約）', aliasesAppend: '別名・ほかの連絡先' };
  let added = 0, updated = 0;
  const newRows = [];
  rows.forEach((r, i) => {
    const key = normKey_(r.key);
    if (!key) throw new Error(`rows[${i}].key が必要です`);
    let row, isNew = false;
    if (idx[key] !== undefined) row = vals[idx[key]].slice();
    else { row = new Array(W).fill(''); row[0] = key; isNew = true; }
    Object.keys(fieldMap).forEach(f => { if (r[f] !== undefined) row[GUEST_COL_[fieldMap[f]]] = String(r[f]); });
    Object.keys(appendMap).forEach(f => {
      if (r[f] === undefined || String(r[f]).trim() === '') return;
      const c = GUEST_COL_[appendMap[f]];
      row[c] = row[c] ? row[c] + '\n' + String(r[f]) : String(r[f]);
    });
    if (!row[GUEST_COL_['区分']]) row[GUEST_COL_['区分']] = '対応中';
    row[GUEST_COL_['更新日時']] = now;
    if (isNew) { newRows.push(row); idx[key] = -1; added++; }
    else {
      const rn = idx[key] + 2;
      sh.getRange(rn, 1, 1, W).setNumberFormat('@').setValues([row]);
      vals[idx[key]] = row;
      updated++;
    }
  });
  if (newRows.length) {
    const start = lastDataRow_(sh, W) + 1;
    sh.getRange(start, 1, newRows.length, W).setNumberFormat('@').setValues(newRows);
  }
  SpreadsheetApp.flush();
  return { ok: true, sheet: GUEST_SHEET_, added: added, updated: updated };
}

function writeApiGuestFind_(q) {
  q = q || {};
  const sh = SpreadsheetApp.getActive().getSheetByName(GUEST_SHEET_);
  if (!sh) return { ok: true, rows: [] };
  const name = q.name ? normText_(q.name) : '';
  const out = [];
  sheetRows_(sh, GUEST_HEADER_.length).forEach((r, i) => {
    if (!r[0]) return;
    if (q.key && r[0] !== q.key && String(r[GUEST_COL_['別名・ほかの連絡先']]).indexOf(q.key) < 0) return;
    if (name) {
      const hay = normText_(r[GUEST_COL_['対象の名前']] + ' ' + r[GUEST_COL_['別名・ほかの連絡先']] + ' ' + r[0]);
      if (hay.indexOf(name) < 0) return;
    }
    if (q.state && r[GUEST_COL_['区分']] !== q.state) return;
    const d = String(r[GUEST_COL_['実施日']] || '').slice(0, 10);
    if (q.from && (!d || d < q.from)) return;
    if (q.to && (!d || d > q.to)) return;
    const o = { row: i + 2 };
    GUEST_HEADER_.forEach((h, j) => { o[h] = r[j]; });
    out.push(o);
  });
  return { ok: true, total: out.length, rows: out };
}

// ---------- 返信ルール ----------
function writeApiRuleAppend_(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows が空です');
  if (rows.length > 300) throw new Error('rows は1回300行まで');
  const sh = ruleSheet_();
  const now = nowJst_();
  const values = rows.map((r, i) => {
    const text = String(r.text || '').trim();
    if (!text) throw new Error(`rows[${i}].text が空です`);
    return [String(r.kind || '返信方針').trim(), String(r.date || '').trim(), text, now];
  });
  const start = lastDataRow_(sh, RULE_HEADER_.length) + 1;
  sh.getRange(start, 1, values.length, RULE_HEADER_.length).setNumberFormat('@').setValues(values);
  SpreadsheetApp.flush();
  return { ok: true, sheet: RULE_SHEET_, rows: values.length, firstRow: start };
}

function writeApiRuleList_(q) {
  q = q || {};
  const sh = SpreadsheetApp.getActive().getSheetByName(RULE_SHEET_);
  if (!sh) return { ok: true, rows: [] };
  const out = [];
  sheetRows_(sh, RULE_HEADER_.length).forEach((r, i) => {
    if (!r[2]) return;
    if (q.kind && r[0] !== q.kind) return;
    out.push({ row: i + 2, 区分: r[0], 日付: r[1], 内容: r[2] });
  });
  return { ok: true, total: out.length, rows: out };
}

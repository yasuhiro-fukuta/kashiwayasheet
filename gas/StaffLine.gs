/**
 * ============================================================
 *  StaffLine.gs - スタッフ連絡LINE（柏屋スタッフ連絡 @093ywlso）の受信と送信  v1.00 (2026-11-23)
 * ============================================================
 *  目的（2026-11-23 社長「なんで俺がお前のために伝書鳩しないといかんの」）：
 *   スタッフ（清掃のYukAさん等）が LINE公式アカウント「柏屋スタッフ連絡」に
 *   書いた文を、Messaging API の Webhook でこの GAS に受け、
 *   シート「スタッフ連絡_受信」に1行ずつ入れる。社長室・定時チェックの Claude が
 *   そのシートを読み、返事の案と社長の判断事項を社長室に出す。
 *   返事は社長の「あ」のあと、Claude が staffline.send（Push API）で送る。
 *
 *  ── 受信（Webhook） ─────────────────────────────────────
 *   LINE の Webhook URL = <このウェブアプリの /exec URL>?src=staffline&k=<合言葉>
 *   ・Apps Script の doPost はリクエストヘッダを読めないので、LINE の署名
 *     (X-Line-Signature) は検証できない。代わりに URL の k（ランダム48文字。
 *     Script Properties にだけ置く）で本物かどうかを見分ける。
 *   ・k が違う／無効のときも 200 で空を返す（相手に手がかりを与えない）。
 *   ・同じイベントの再送は webhookEventId で1回だけ記録する。
 *   ・画像・スタンプ等は種類と messageId だけ記録する（中身は staffline.content で取る）。
 *   ・自動の受付返信（Reply API。通数に数えない）は STAFF_LINE_AUTO_ACK=1 のときだけ。
 *     既定は送らない（スタッフへの送信は社長の「あ」の後、の原則のため）。
 *
 *  ── WriteApi.gs から呼ぶ action（合言葉つき POST） ─────────────
 *   staffline.setup   {channelAccessToken?, execUrl?, rotateKey?, autoAck?}
 *                     トークンを保存し、合言葉 k を作り（無ければ）、2つのタブを作る。
 *                     execUrl を渡すと LINE の Webhook URL を API で設定し、テストを1回送る。
 *                     ★返り値にトークン・合言葉は出さない（webhookSet・test の結果だけ）。
 *   staffline.status  設定の有無・行数・未読数・今月の送信数（LINE の quota API）
 *   staffline.list    {status?, limit?}  受信行を新しい順に返す
 *   staffline.setRow  {row, status?, draft?, ask?, memo?}  返信案・判断事項・状態を書く
 *   staffline.setName {userId, staffName}  名簿の「スタッフ名」を書く（受信行の C 列も埋め直す）
 *   staffline.send    {row, text, approval}  ★社長の「あ」の後だけ。approval に
 *                     「社長あ YYYY-MM-DD HH:mm」を入れる（記録に残す）。Push API で送る。
 *                     同じ行の二重送信は拒否（force:true で再送）。
 *   staffline.content {messageId}  画像などの中身を base64 で返す（10MB まで）
 *   staffline.off     受信を止める（STAFF_LINE_ENABLED=0。記録・設定は残す）
 *
 *  ── 権限 ─────────────────────────────────────────────
 *   使うのは SpreadsheetApp・UrlFetchApp・PropertiesService・Utilities だけで、
 *   どれもこのプロジェクトで既に使っている（承認済み）。新しい承認は要らない。
 *   appsscript.json は変えない（oauthScopes を書き足すと既存機能の権限まで
 *   作り直しになり、取りこぼすと全体が止まるため）。
 *
 *  ── 通数（無料のコミュニケーションプラン：月200通） ───────────────
 *   数える：Push API（staffline.send）・一斉配信（毎週月曜の連絡）
 *   数えない：Reply API（自動の受付返信）・LINE チャット画面での手打ち返信
 *   上限に達すると Push は 429 で失敗する → 行の P 列に記録し、状態を「送信失敗」にする。
 * ============================================================
 */

const STAFF_LINE_ = {
  SHEET_IN: 'スタッフ連絡_受信',
  SHEET_ROSTER: 'スタッフ連絡_名簿',
  HEADER_IN: ['受信日時', 'イベント', 'スタッフ名', 'LINE表示名', 'userId', '種類', '本文',
              'messageId', 'webhookEventId', '状態', '返信案', '社長の判断事項', '送信文',
              '送信日時', '送信方法', '送信結果', 'メモ'],
  HEADER_ROSTER: ['userId', 'LINE表示名', 'スタッフ名', '最初', '最後', '友だち'],
  COL: { RECV: 1, EVENT: 2, STAFF: 3, DISP: 4, UID: 5, KIND: 6, TEXT: 7, MID: 8, EID: 9,
         STATUS: 10, DRAFT: 11, ASK: 12, SENT_TEXT: 13, SENT_AT: 14, SENT_HOW: 15, SENT_RESULT: 16, MEMO: 17 },
  STATUSES: ['未読', '案あり', '承認待ち', '送信済', '対応不要', '送信失敗'],
  PROP_TOKEN: 'STAFF_LINE_TOKEN',
  PROP_KEY: 'STAFF_LINE_WEBHOOK_KEY',
  PROP_ENABLED: 'STAFF_LINE_ENABLED',
  PROP_AUTO_ACK: 'STAFF_LINE_AUTO_ACK',
  PROP_ACKED: 'STAFF_LINE_ACKED',      // {userId: ms} 自動受付返信の間引き用
  ACK_TEXT: '受け取りました。確認して、こちらから返事します。（柏屋）',
  ACK_EVERY_MS: 30 * 60 * 1000,
  DEDUPE_SCAN: 300,
  API: 'https://api.line.me',
  API_DATA: 'https://api-data.line.me',
};

// ------------------------------------------------------------
//  純粋関数（シートにもネットにも触らない。test/staff-line.test.js で検証）
// ------------------------------------------------------------

/** Webhook の URL の合言葉が正しいか（定数時間比較） */
function staffLineKeyOk_(given, expected) {
  const a = String(given || ''), b = String(expected || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** LINE の1イベントを記録用の形にする。記録しないイベントは null */
function staffLineEventToRecord_(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const src = ev.source || {};
  const uid = String(src.userId || '');
  const base = {
    ts: Number(ev.timestamp) || Date.now(),
    event: String(ev.type || ''),
    userId: uid,
    groupId: String(src.groupId || src.roomId || ''),
    kind: '', text: '', messageId: '',
    eventId: String(ev.webhookEventId || ''),
    replyToken: String(ev.replyToken || ''),
    redelivery: !!(ev.deliveryContext && ev.deliveryContext.isRedelivery),
  };
  if (ev.type === 'message') {
    const m = ev.message || {};
    base.kind = String(m.type || '');
    base.messageId = String(m.id || '');
    if (m.type === 'text') base.text = String(m.text || '');
    else if (m.type === 'sticker') base.text = '[スタンプ]';
    else if (m.type === 'image') base.text = '[画像] staffline.content で取得';
    else if (m.type === 'video') base.text = '[動画] staffline.content で取得';
    else if (m.type === 'audio') base.text = '[音声] staffline.content で取得';
    else if (m.type === 'file') base.text = `[ファイル] ${m.fileName || ''}`;
    else if (m.type === 'location') base.text = `[位置] ${m.title || ''} ${m.address || ''} (${m.latitude},${m.longitude})`;
    else base.text = `[${m.type || '不明'}]`;
    return base;
  }
  if (ev.type === 'follow') { base.kind = 'follow'; base.text = '[友だち追加]'; return base; }
  if (ev.type === 'unfollow') { base.kind = 'unfollow'; base.text = '[ブロック]'; return base; }
  if (ev.type === 'join') { base.kind = 'join'; base.text = '[グループに参加]'; return base; }
  if (ev.type === 'postback') { base.kind = 'postback'; base.text = `[postback] ${(ev.postback && ev.postback.data) || ''}`; return base; }
  return null;  // leave / memberJoined / unsend 等は記録しない
}

/** 受信日時の文字列（日本時間） */
function staffLineJst_(ms) {
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  const p = n => ('0' + n).slice(-2);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 記録 → シートの1行（A〜Q） */
function staffLineRecordToRow_(rec, staffName, displayName) {
  const row = new Array(STAFF_LINE_.HEADER_IN.length).fill('');
  const C = STAFF_LINE_.COL;
  row[C.RECV - 1] = staffLineJst_(rec.ts);
  row[C.EVENT - 1] = rec.event;
  row[C.STAFF - 1] = staffName || '';
  row[C.DISP - 1] = displayName || '';
  row[C.UID - 1] = rec.groupId ? `${rec.userId} (group ${rec.groupId})` : rec.userId;
  row[C.KIND - 1] = rec.kind;
  //  セルの先頭が = + - @ だと式として読まれるので ' を付ける
  row[C.TEXT - 1] = /^[=+\-@]/.test(rec.text) ? "'" + rec.text : rec.text;
  row[C.MID - 1] = rec.messageId;
  row[C.EID - 1] = rec.eventId;
  row[C.STATUS - 1] = rec.event === 'message' ? '未読' : '対応不要';
  row[C.MEMO - 1] = rec.redelivery ? 'LINE再送' : '';
  return row;
}

/** 自動受付返信を送ってよいか（設定ON・テキスト等の message・同じ人に30分以内に送っていない） */
function staffLineShouldAck_(rec, autoAck, ackedMap, nowMs) {
  if (!autoAck) return false;
  if (!rec || rec.event !== 'message' || !rec.replyToken || rec.groupId) return false;
  const last = Number((ackedMap || {})[rec.userId] || 0);
  return !(last && nowMs - last < STAFF_LINE_.ACK_EVERY_MS);
}

/** staffline.send の入力チェック。問題があれば理由の文字列、無ければ '' */
function staffLineSendProblem_(row, text, approval, currentStatus, force) {
  if (!Number.isInteger(row) || row < 2) return 'row は2以上の行番号';
  const t = String(text || '');
  if (!t.trim()) return 'text が空';
  if (t.length > 5000) return 'text は5000字まで';
  if (!/^社長あ \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(approval || ''))) {
    return 'approval は「社長あ YYYY-MM-DD HH:mm」（社長の「あ」の時刻）';
  }
  if (currentStatus === '送信済' && !force) return 'この行は送信済み（再送は force:true）';
  return '';
}

// ------------------------------------------------------------
//  Webhook（WriteApi.gs の doPost から ?src=staffline のときに呼ぶ）
// ------------------------------------------------------------
function staffLineHandleWebhook_(e) {
  const props = PropertiesService.getScriptProperties();
  const ok = staffLineKeyOk_(e && e.parameter && e.parameter.k, props.getProperty(STAFF_LINE_.PROP_KEY));
  if (!ok || props.getProperty(STAFF_LINE_.PROP_ENABLED) === '0') {
    return ContentService.createTextOutput('');
  }
  let body;
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { return ContentService.createTextOutput(''); }
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return ContentService.createTextOutput('');  // 検証用の空イベント

  try {
    const sh = staffLineSheet_(STAFF_LINE_.SHEET_IN, STAFF_LINE_.HEADER_IN);
    const seen = staffLineRecentEventIds_(sh);
    const token = props.getProperty(STAFF_LINE_.PROP_TOKEN);
    const autoAck = props.getProperty(STAFF_LINE_.PROP_AUTO_ACK) === '1';
    let acked = {};
    try { acked = JSON.parse(props.getProperty(STAFF_LINE_.PROP_ACKED) || '{}'); } catch (err) { acked = {}; }
    let ackedChanged = false;

    events.forEach(ev => {
      const rec = staffLineEventToRecord_(ev);
      if (!rec) return;
      if (rec.eventId && seen[rec.eventId]) return;
      const who = staffLineRosterTouch_(rec, token);
      sh.appendRow(staffLineRecordToRow_(rec, who.staffName, who.displayName));
      if (rec.eventId) seen[rec.eventId] = true;
      if (token && staffLineShouldAck_(rec, autoAck, acked, Date.now())) {
        const r = staffLineApi_('post', '/v2/bot/message/reply', token,
          { replyToken: rec.replyToken, messages: [{ type: 'text', text: STAFF_LINE_.ACK_TEXT }] });
        if (r.code === 200) { acked[rec.userId] = Date.now(); ackedChanged = true; }
      }
    });
    if (ackedChanged) props.setProperty(STAFF_LINE_.PROP_ACKED, JSON.stringify(acked));
  } catch (err) {
    console.error('staffLineHandleWebhook_: ' + (err && err.stack || err));
  }
  return ContentService.createTextOutput('');
}

// ------------------------------------------------------------
//  シート
// ------------------------------------------------------------
function staffLineSheet_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function staffLineRecentEventIds_(sh) {
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  const n = Math.min(STAFF_LINE_.DEDUPE_SCAN, last - 1);
  sh.getRange(last - n + 1, STAFF_LINE_.COL.EID, n, 1).getValues().forEach(r => { if (r[0]) out[String(r[0])] = true; });
  return out;
}

/** 名簿に userId を記録・更新し、{staffName, displayName} を返す */
function staffLineRosterTouch_(rec, token) {
  const out = { staffName: '', displayName: '' };
  if (!rec.userId) return out;
  const sh = staffLineSheet_(STAFF_LINE_.SHEET_ROSTER, STAFF_LINE_.HEADER_ROSTER);
  const now = staffLineJst_(Date.now());
  const last = sh.getLastRow();
  const vals = last >= 2 ? sh.getRange(2, 1, last - 1, 6).getValues() : [];
  const i = vals.findIndex(r => String(r[0]) === rec.userId);
  const friend = rec.event === 'unfollow' ? 'ブロック' : '友だち';
  if (i >= 0) {
    out.displayName = String(vals[i][1] || '');
    out.staffName = String(vals[i][2] || '');
    sh.getRange(i + 2, 5, 1, 2).setValues([[now, friend]]);
    return out;
  }
  if (token && rec.event !== 'unfollow') {
    const r = staffLineApi_('get', '/v2/bot/profile/' + encodeURIComponent(rec.userId), token);
    if (r.code === 200 && r.json) out.displayName = String(r.json.displayName || '');
  }
  sh.appendRow([rec.userId, out.displayName, '', now, now, friend]);
  return out;
}

// ------------------------------------------------------------
//  LINE API
// ------------------------------------------------------------
function staffLineApi_(method, path, token, payload, base) {
  const opt = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token } };
  if (payload !== undefined) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(payload); }
  const res = UrlFetchApp.fetch((base || STAFF_LINE_.API) + path, opt);
  const code = res.getResponseCode();
  let json = null;
  try { json = JSON.parse(res.getContentText() || 'null'); } catch (err) { json = null; }
  return { code: code, json: json, res: res };
}

function staffLineToken_() {
  const t = PropertiesService.getScriptProperties().getProperty(STAFF_LINE_.PROP_TOKEN);
  if (!t) throw new Error('チャネルアクセストークンが未設定（staffline.setup で channelAccessToken を渡す）');
  return t;
}

// ------------------------------------------------------------
//  WriteApi の action
// ------------------------------------------------------------
function staffLineSetup_(body) {
  const b = body || {};
  const props = PropertiesService.getScriptProperties();
  if (b.channelAccessToken && String(b.channelAccessToken).trim()) {
    props.setProperty(STAFF_LINE_.PROP_TOKEN, String(b.channelAccessToken).trim());
  }
  if (!props.getProperty(STAFF_LINE_.PROP_KEY) || b.rotateKey === true) {
    props.setProperty(STAFF_LINE_.PROP_KEY, Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16));
  }
  if (b.autoAck === true) props.setProperty(STAFF_LINE_.PROP_AUTO_ACK, '1');
  if (b.autoAck === false) props.setProperty(STAFF_LINE_.PROP_AUTO_ACK, '0');
  props.setProperty(STAFF_LINE_.PROP_ENABLED, '1');
  staffLineSheet_(STAFF_LINE_.SHEET_IN, STAFF_LINE_.HEADER_IN);
  staffLineSheet_(STAFF_LINE_.SHEET_ROSTER, STAFF_LINE_.HEADER_ROSTER);

  const out = { ok: true, hasToken: !!props.getProperty(STAFF_LINE_.PROP_TOKEN) };
  const token = props.getProperty(STAFF_LINE_.PROP_TOKEN);
  if (token) {
    const bot = staffLineApi_('get', '/v2/bot/info', token);
    out.botInfo = bot.code === 200 && bot.json ? { basicId: bot.json.basicId, displayName: bot.json.displayName, chatMode: bot.json.chatMode } : { error: bot.code };
  }
  if (token && b.execUrl) {
    const exec = String(b.execUrl).trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(exec)) throw new Error('execUrl は https://script.google.com/macros/s/…/exec の形で');
    const endpoint = `${exec}?src=staffline&k=${props.getProperty(STAFF_LINE_.PROP_KEY)}`;
    const set = staffLineApi_('put', '/v2/bot/channel/webhook/endpoint', token, { endpoint: endpoint });
    out.webhookSet = set.code === 200;
    if (!out.webhookSet) out.webhookSetError = { code: set.code, body: set.json };
    const t = staffLineApi_('post', '/v2/bot/channel/webhook/test', token, { endpoint: endpoint });
    //  GAS は 302 を返すため test は success:false（statusCode 302）になることがある。
    //  その場合も doPost は動いている。本当の確認はスタッフ側から1通送ってシートに行が増えるかで見る。
    out.webhookTest = t.json ? { success: t.json.success, statusCode: t.json.statusCode, reason: t.json.reason } : { code: t.code };
    const info = staffLineApi_('get', '/v2/bot/channel/webhook/endpoint', token);
    out.webhookActive = info.json ? !!info.json.active : null;  // false なら「Webhookの利用」がオフ
  }
  return Object.assign(out, staffLineStatusBody_());
}

function staffLineStatus_() { return Object.assign({ ok: true }, staffLineStatusBody_()); }

function staffLineStatusBody_() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(STAFF_LINE_.SHEET_IN);
  let rows = 0, unread = 0;
  if (sh && sh.getLastRow() >= 2) {
    const st = sh.getRange(2, STAFF_LINE_.COL.STATUS, sh.getLastRow() - 1, 1).getValues();
    rows = st.length;
    unread = st.filter(r => r[0] === '未読' || r[0] === '案あり' || r[0] === '承認待ち').length;
  }
  const out = {
    hasToken: !!props.getProperty(STAFF_LINE_.PROP_TOKEN),
    hasKey: !!props.getProperty(STAFF_LINE_.PROP_KEY),
    enabled: props.getProperty(STAFF_LINE_.PROP_ENABLED) !== '0',
    autoAck: props.getProperty(STAFF_LINE_.PROP_AUTO_ACK) === '1',
    rows: rows, open: unread,
  };
  const token = props.getProperty(STAFF_LINE_.PROP_TOKEN);
  if (token) {
    const q = staffLineApi_('get', '/v2/bot/message/quota', token);
    const c = staffLineApi_('get', '/v2/bot/message/quota/consumption', token);
    out.quota = { limit: q.json && q.json.value, type: q.json && q.json.type, usedThisMonth: c.json && c.json.totalUsage };
  }
  return out;
}

function staffLineList_(body) {
  const b = body || {};
  const sh = SpreadsheetApp.getActive().getSheetByName(STAFF_LINE_.SHEET_IN);
  if (!sh || sh.getLastRow() < 2) return { ok: true, rows: [] };
  const limit = Math.min(Math.max(Number(b.limit) || 30, 1), 200);
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, STAFF_LINE_.HEADER_IN.length).getDisplayValues();
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < limit; i--) {
    const r = vals[i];
    if (b.status && r[STAFF_LINE_.COL.STATUS - 1] !== b.status) continue;
    const o = { row: i + 2 };
    STAFF_LINE_.HEADER_IN.forEach((h, j) => { o[h] = r[j]; });
    out.push(o);
  }
  return { ok: true, rows: out };
}

function staffLineSetRow_(body) {
  const b = body || {};
  const row = Number(b.row);
  const sh = SpreadsheetApp.getActive().getSheetByName(STAFF_LINE_.SHEET_IN);
  if (!sh || !Number.isInteger(row) || row < 2 || row > sh.getLastRow()) throw new Error('row が範囲外');
  const C = STAFF_LINE_.COL;
  if (b.status !== undefined) {
    if (STAFF_LINE_.STATUSES.indexOf(b.status) < 0) throw new Error('status は ' + STAFF_LINE_.STATUSES.join('/'));
    if (b.status === '送信済') throw new Error('送信済 は staffline.send だけが書く');
    sh.getRange(row, C.STATUS).setValue(b.status);
  }
  if (b.draft !== undefined) sh.getRange(row, C.DRAFT).setValue(String(b.draft));
  if (b.ask !== undefined) sh.getRange(row, C.ASK).setValue(String(b.ask));
  if (b.memo !== undefined) sh.getRange(row, C.MEMO).setValue(String(b.memo));
  return { ok: true, row: row };
}

function staffLineSetName_(body) {
  const b = body || {};
  const uid = String(b.userId || '').trim();
  const name = String(b.staffName || '').trim();
  if (!/^U[0-9a-f]{32}$/.test(uid)) throw new Error('userId の形が違う');
  const ro = staffLineSheet_(STAFF_LINE_.SHEET_ROSTER, STAFF_LINE_.HEADER_ROSTER);
  const last = ro.getLastRow();
  const ids = last >= 2 ? ro.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
  const i = ids.indexOf(uid);
  if (i < 0) throw new Error('名簿にその userId が無い');
  ro.getRange(i + 2, 3).setValue(name);
  //  受信行のスタッフ名も埋める
  const sh = SpreadsheetApp.getActive().getSheetByName(STAFF_LINE_.SHEET_IN);
  let filled = 0;
  if (sh && sh.getLastRow() >= 2) {
    const n = sh.getLastRow() - 1;
    const uids = sh.getRange(2, STAFF_LINE_.COL.UID, n, 1).getValues();
    const names = sh.getRange(2, STAFF_LINE_.COL.STAFF, n, 1).getValues();
    uids.forEach((r, k) => { if (String(r[0]).indexOf(uid) === 0 && names[k][0] !== name) { names[k][0] = name; filled++; } });
    if (filled) sh.getRange(2, STAFF_LINE_.COL.STAFF, n, 1).setValues(names);
  }
  return { ok: true, userId: uid, staffName: name, rowsFilled: filled };
}

function staffLineSend_(body) {
  const b = body || {};
  const row = Number(b.row);
  const sh = SpreadsheetApp.getActive().getSheetByName(STAFF_LINE_.SHEET_IN);
  if (!sh || row > sh.getLastRow()) throw new Error('row が範囲外');
  const C = STAFF_LINE_.COL;
  const cur = String(sh.getRange(row, C.STATUS).getValue() || '');
  const problem = staffLineSendProblem_(row, b.text, b.approval, cur, b.force === true);
  if (problem) return { ok: false, error: problem };
  const uidCell = String(sh.getRange(row, C.UID).getValue() || '');
  const uid = uidCell.split(' ')[0];
  if (!/^U[0-9a-f]{32}$/.test(uid)) return { ok: false, error: 'この行に送り先の userId が無い' };

  const token = staffLineToken_();
  const r = staffLineApi_('post', '/v2/bot/message/push', token,
    { to: uid, messages: [{ type: 'text', text: String(b.text) }] });
  const at = staffLineJst_(Date.now());
  const okSend = r.code === 200;
  const result = okSend ? `OK ${b.approval}` : `NG ${r.code} ${(r.json && r.json.message) || ''} (${b.approval})`;
  sh.getRange(row, C.SENT_TEXT, 1, 4).setValues([[String(b.text), at, 'push', result]]);
  sh.getRange(row, C.STATUS).setValue(okSend ? '送信済' : '送信失敗');
  return { ok: okSend, row: row, code: r.code, error: okSend ? undefined : (r.json && r.json.message) || ('HTTP ' + r.code) };
}

function staffLineContent_(body) {
  const mid = String((body || {}).messageId || '').trim();
  if (!/^\d+$/.test(mid)) throw new Error('messageId は数字');
  const r = staffLineApi_('get', `/v2/bot/message/${mid}/content`, staffLineToken_(), undefined, STAFF_LINE_.API_DATA);
  if (r.code !== 200) return { ok: false, error: 'HTTP ' + r.code };
  const blob = r.res.getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > 10 * 1024 * 1024) return { ok: false, error: '10MB を超える' };
  return { ok: true, contentType: blob.getContentType(), size: bytes.length, base64: Utilities.base64Encode(bytes) };
}

function staffLineOff_() {
  PropertiesService.getScriptProperties().setProperty(STAFF_LINE_.PROP_ENABLED, '0');
  return { ok: true, enabled: false };
}

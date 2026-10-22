/**
 * ============================================================
 *  WriteApi.gs - Claude（O_メッセージ受付）向けの書き込み Web API  v1.00
 * ============================================================
 *  ゲストへの返信案を作った Claude が、決まった事項をその場で
 *  シートに書き、必要ならバッチを回すための入口。
 *  (2026-10-19 社長決定：O_メッセージ受付で 返信案4セット＋台帳＋スプシ＋GAS を一度に回す)
 *
 *  呼び出し:  POST <ウェブアプリURL>
 *             Content-Type: application/json
 *             { "token": "...", "action": "...", ... }
 *
 *  token は合言葉そのものではなく、その SHA-256 だけをここに置く
 *  (このリポジトリは公開なので、合言葉は書かない)。合言葉の本体は
 *  Drive「Claude共有_事業全般 / 00_最初に読む」にだけある。
 *  読み取り用 (WebApi.gs の doGet / WEB_API_TOKEN) とは別の合言葉。
 *
 *  action:
 *   dmOrder.append    … 「DMからの食事注文」に行を足す
 *                        rows: [{date, room, guest, item, persons, time, channel, dmDate, status, memo}]
 *                        ★既存行は書き換えない。修正は「取消」行＋新しい「有効」行を足す。
 *   option.append     … 「オプション予約」に行を足す (A〜J。K・L は GAS が書く)
 *                        rows: [{date, kind, guest, room, start, end, qty, vendor, memo, status}]
 *   option.setStatus  … 「オプション予約」の J列(状態) を変える
 *                        match: {date, kind, guest}  status: '確定' | '取消'
 *                        ★一致した行の J 列だけを書く。他の列は触らない。
 *   board.setStaff    … CleaningBoard の A列(清掃担当)・D列(接客担当) を書く
 *                        rows: [{date, room, day?, night?}]
 *                        day/night を省略した列は触らない。'' は空にする。
 *                        名前は Staff シートの名前(照合用) か '' のみ。
 *                        ★A・D列以外は触らない (B・C は人が書く。E〜T は GAS)。
 *   override.append   … 「CleaningOverride」に行を足す (人が書くシート。GAS は読むだけ)
 *                        rows: [{date, room, people?, name?, memo?, meal?}]
 *   cell.set          … 決まったセルに値を書く (社長決定の反映用。2026-10-21)
 *                        file: 'master' | 'order'  (master=このブック、order=柏屋注文確認票)
 *                        sheet: タブ名、cells: [{a1:'D47', value:'…'}]  ('' で空欄)
 *                        ★書ける範囲は WRITE_API_CELL_RULES_ に限る
 *                          (CleaningBoard の E〜T など GAS が書く列には書かない)。
 *   handover.append   … 「清掃全体申し送り事項」に行を足す  rows: [{date, text, by?}]
 *   batch.run         … 毎時バッチ (hourlySync) を今すぐ回す
 *   ping              … 疎通確認
 *
 *  返り値: { ok: true, ... } / { ok: false, error: '...' }
 * ============================================================
 */

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ ok: false, error: 'invalid json' });
  }

  if (!writeApiTokenOk_(body.token)) {
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }

  const action = String(body.action || '');
  try {
    if (action === 'ping') return jsonOut_({ ok: true, now: nowJst_() });
    if (action === 'batch.run') return jsonOut_(writeApiRunBatch_());

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30 * 1000)) return jsonOut_({ ok: false, error: 'busy (バッチ実行中)。少し待って再送' });
    try {
      if (action === 'dmOrder.append') return jsonOut_(writeApiDmOrderAppend_(body.rows));
      if (action === 'option.append') return jsonOut_(writeApiOptionAppend_(body.rows));
      if (action === 'option.setStatus') return jsonOut_(writeApiOptionSetStatus_(body.match, body.status));
      if (action === 'board.setStaff') return jsonOut_(writeApiBoardSetStaff_(body.rows));
      if (action === 'override.append') return jsonOut_(writeApiOverrideAppend_(body.rows));
      if (action === 'handover.append') return jsonOut_(writeApiHandoverAppend_(body.rows));
      if (action === 'cell.set') return jsonOut_(writeApiCellSet_(body.file, body.sheet, body.cells));
    } finally {
      lock.releaseLock();
    }
    return jsonOut_({ ok: false, error: `unknown action: ${action}` });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

//  合言葉の SHA-256 (16進)。合言葉を変えるときはここを差し替える。
const WRITE_API_TOKEN_SHA256_ = 'dfba0da705f949c06c2400a15a25ef73928c578173ae2b831dbfb9390a1d73e5';

function writeApiTokenOk_(token) {
  const t = String(token || '');
  if (!t) return false;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, t, Utilities.Charset.UTF_8);
  const hex = digest.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
  return hex === WRITE_API_TOKEN_SHA256_;
}

function nowJst_() {
  return Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm');
}

function requireRows_(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows が空です');
  if (rows.length > 50) throw new Error('rows は1回50行まで');
  return rows;
}

function requireDate_(v, label) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${label} は yyyy-MM-dd で: "${s}"`);
  return s;
}

function writeApiDmOrderAppend_(rows) {
  const D = CONFIG.DM_ORDERS;
  requireRows_(rows);
  const sh = ensureDmOrderSheet_();
  const statuses = [D.STATUS_ACTIVE, D.STATUS_CANCEL, '未確定', '対応済'];
  const values = rows.map((r, i) => {
    const date = requireDate_(r.date, `rows[${i}].date`);
    const room = String(r.room || '').trim();
    if (CONFIG.CLEANING.ROOMS.indexOf(room) < 0) throw new Error(`rows[${i}].room は ${CONFIG.CLEANING.ROOMS.join('/')} のどれか: "${room}"`);
    const status = String(r.status || D.STATUS_ACTIVE).trim();
    if (statuses.indexOf(status) < 0) throw new Error(`rows[${i}].status は ${statuses.join('/')} のどれか: "${status}"`);
    const persons = Number(r.persons);
    if (!(persons > 0)) throw new Error(`rows[${i}].persons は1以上の数`);
    return [
      date, room, String(r.guest || '').trim(), String(r.item || '').trim(), persons,
      String(r.time || '').trim(), String(r.channel || '').trim(),
      r.dmDate ? requireDate_(r.dmDate, `rows[${i}].dmDate`) : '',
      status, String(r.memo || '').trim(),
    ];
  });
  const start = Math.max(sh.getLastRow(), 2) + 1;
  sh.getRange(start, 1, values.length, D.HEADER.length).setValues(values);
  SpreadsheetApp.flush();
  return { ok: true, sheet: D.SHEET_NAME, rows: values.length, firstRow: start };
}

function writeApiOptionAppend_(rows) {
  const B = CONFIG.OPTION_BOOKING;
  const C = CONFIG.COL_OPTBK;
  requireRows_(rows);
  const sh = ensureOptionBookingSheet();
  const values = rows.map((r, i) => {
    const date = requireDate_(r.date, `rows[${i}].date`);
    const kind = String(r.kind || '').trim();
    if (!kind) throw new Error(`rows[${i}].kind が空です`);
    const status = String(r.status || B.STATUS_FIXED).trim();
    if ([B.STATUS_FIXED, B.STATUS_CANCEL].indexOf(status) < 0) throw new Error(`rows[${i}].status は ${B.STATUS_FIXED}/${B.STATUS_CANCEL}`);
    return [
      date, kind, String(r.guest || '').trim(), String(r.room || '').trim(),
      String(r.start || '').trim(), String(r.end || '').trim(),
      r.qty === undefined || r.qty === null || r.qty === '' ? '' : Number(r.qty),
      String(r.vendor || '').trim(), String(r.memo || '').trim(), status,
    ];
  });
  const start = Math.max(sh.getLastRow(), 1) + 1;
  //  A列(実施日)と時刻列は文字列で入れる (日付・時刻の自動変換でずれないように)
  sh.getRange(start, C.DATE, values.length, 1).setNumberFormat('@');
  sh.getRange(start, C.START, values.length, 2).setNumberFormat('@');
  sh.getRange(start, 1, values.length, C.STATUS).setValues(values);
  SpreadsheetApp.flush();
  return { ok: true, sheet: B.SHEET, rows: values.length, firstRow: start };
}

function writeApiOptionSetStatus_(match, status) {
  const B = CONFIG.OPTION_BOOKING;
  const C = CONFIG.COL_OPTBK;
  if (!match) throw new Error('match が空です');
  const date = requireDate_(match.date, 'match.date');
  const kind = String(match.kind || '').trim();
  const guest = String(match.guest || '').trim().toLowerCase();
  if (!kind || !guest) throw new Error('match.kind と match.guest は必須');
  const st = String(status || '').trim();
  if ([B.STATUS_FIXED, B.STATUS_CANCEL].indexOf(st) < 0) throw new Error(`status は ${B.STATUS_FIXED}/${B.STATUS_CANCEL}`);

  const sh = SpreadsheetApp.getActive().getSheetByName(B.SHEET);
  if (!sh) throw new Error(`「${B.SHEET}」シートがありません`);
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, changed: 0, rows: [] };
  const vals = sh.getRange(2, 1, last - 1, C.STATUS).getDisplayValues();
  const changed = [];
  vals.forEach((r, i) => {
    const d = String(r[C.DATE - 1] || '').trim().replace(/\//g, '-');
    if (d !== date) return;
    if (String(r[C.KIND - 1] || '').trim() !== kind) return;
    if (String(r[C.GUEST_NAME - 1] || '').trim().toLowerCase() !== guest) return;
    if (String(r[C.STATUS - 1] || '').trim() === st) return;
    sh.getRange(i + 2, C.STATUS).setValue(st);
    changed.push(i + 2);
  });
  SpreadsheetApp.flush();
  return { ok: true, changed: changed.length, rows: changed };
}

function writeApiBoardSetStaff_(rows) {
  const C = CONFIG.COL_CLEAN;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows が空です');
  if (rows.length > 200) throw new Error('rows は1回200行まで');

  const staffSh = SpreadsheetApp.getActive().getSheetByName('Staff');
  if (!staffSh) throw new Error('「Staff」シートがありません');
  const names = staffSh.getLastRow() < 2 ? [] :
    staffSh.getRange(2, 1, staffSh.getLastRow() - 1, 1).getDisplayValues()
      .map(r => String(r[0] || '').trim()).filter(Boolean);
  const checkName = (v, label) => {
    const n = String(v).trim();
    if (n && names.indexOf(n) < 0) throw new Error(`${label} は Staff シートに無い名前: "${n}"（${names.join('/')}）`);
    return n;
  };

  const sh = ensureCleaningSheet();
  const last = sh.getLastRow();
  if (last < 2) throw new Error('CleaningBoard が空です');
  const keys = sh.getRange(2, C.KEY, last - 1, 1).getDisplayValues().map(r => String(r[0] || '').trim());

  //  先に全行を検証してから書く (途中で失敗して半端に書かれないように)
  const plan = rows.map((r, i) => {
    const date = requireDate_(r.date, `rows[${i}].date`);
    const room = String(r.room || '').trim();
    if (CONFIG.CLEANING.ROOMS.indexOf(room) < 0) throw new Error(`rows[${i}].room は ${CONFIG.CLEANING.ROOMS.join('/')} のどれか: "${room}"`);
    const idx = keys.indexOf(`${date}_${room}`);
    if (idx < 0) throw new Error(`rows[${i}] の行がボードにありません: ${date}_${room}`);
    const p = { row: idx + 2 };
    if (r.day !== undefined && r.day !== null) p.day = checkName(r.day, `rows[${i}].day`);
    if (r.night !== undefined && r.night !== null) p.night = checkName(r.night, `rows[${i}].night`);
    if (p.day === undefined && p.night === undefined) throw new Error(`rows[${i}] は day か night のどちらかが必要`);
    return p;
  });

  plan.forEach(p => {
    if (p.day !== undefined) sh.getRange(p.row, C.STAFF_DAY).setValue(p.day);
    if (p.night !== undefined) sh.getRange(p.row, C.STAFF_NIGHT).setValue(p.night);
  });
  SpreadsheetApp.flush();
  return { ok: true, sheet: 'CleaningBoard', rows: plan.length };
}

function writeApiOverrideAppend_(rows) {
  const C = CONFIG.COL_OVR;
  requireRows_(rows);
  const sh = ensureOverrideSheet();
  const values = rows.map((r, i) => {
    const date = requireDate_(r.date, `rows[${i}].date`);
    const room = String(r.room || '').trim();
    if (CONFIG.CLEANING.ROOMS.indexOf(room) < 0) throw new Error(`rows[${i}].room は ${CONFIG.CLEANING.ROOMS.join('/')} のどれか: "${room}"`);
    const row = new Array(C.MEAL).fill('');
    row[C.CHECKIN - 1]    = date;
    row[C.ROOM - 1]       = room;
    row[C.GUESTS - 1]     = (r.people === undefined || r.people === null || r.people === '') ? '' : Number(r.people);
    row[C.GUEST_NAME - 1] = String(r.name || '').trim();
    row[C.MEMO - 1]       = String(r.memo || '').trim();
    row[C.MEAL - 1]       = String(r.meal || '').trim();
    return row;
  });
  // 空行を探して書く (シートは1000行の空枠があるので getLastRow が正)
  const start = Math.max(sh.getLastRow(), 1) + 1;
  sh.getRange(start, C.CHECKIN, values.length, 1).setNumberFormat('@');
  sh.getRange(start, 1, values.length, C.MEAL).setValues(values);
  SpreadsheetApp.flush();
  return { ok: true, sheet: CONFIG.SHEET.CLEAN_OVERRIDE, rows: values.length, firstRow: start };
}

//  cell.set で書いてよい場所。file → { id, sheets: { タブ名(正規表現) → 列(正規表現) } }
//  ★GAS が毎時書き換える列 (CleaningBoard E〜T、LatestOptions の B 以外) は書かない。
const WRITE_API_CELL_RULES_ = {
  master: {
    id: null,   // このブック
    sheets: [
      { sheet: /^CleaningBoard$/,   col: /^[A-DU-X]$/ },      // 手動列のみ
      { sheet: /^LatestOptions$/,   col: /^B$/ },             // 論理削除フラグのみ
      { sheet: /^CleaningOverride$/, col: /^[A-F]$/ },
      { sheet: /^DMからの食事注文$/, col: /^[A-J]$/ },
      { sheet: /^オプション予約$/,  col: /^[A-J]$/ },
    ],
  },
  order: {
    id: '1UHVicDOlgA597o7ahXYOgP0bNQnKan_1t7kc2VfkXqc',   // 柏屋注文確認票 (ほなみや共有)
    sheets: [{ sheet: /^R\s*\d+\s*\S*月\s*$/, col: /^[A-Z]$/ }],
  },
};

function writeApiCellSet_(file, sheetName, cells) {
  const rule = WRITE_API_CELL_RULES_[String(file || '')];
  if (!rule) throw new Error(`file は ${Object.keys(WRITE_API_CELL_RULES_).join('/')} のどれか`);
  const name = String(sheetName || '');
  if (!Array.isArray(cells) || !cells.length) throw new Error('cells が空です');
  if (cells.length > 50) throw new Error('cells は1回50個まで');

  const ss = rule.id ? SpreadsheetApp.openById(rule.id) : SpreadsheetApp.getActive();
  //  タブ名は前後の空白ゆれがあるので、正規化して探す
  const norm = x => String(x).normalize('NFKC').replace(/\s+/g, '');
  const sh = ss.getSheets().find(s => norm(s.getName()) === norm(name)) || null;
  if (!sh) throw new Error(`タブが見つかりません: "${name}"`);
  const sheetRule = rule.sheets.find(r => r.sheet.test(norm(sh.getName())));
  if (!sheetRule) throw new Error(`このタブには書けません: "${sh.getName()}"`);

  //  先に全部検証してから書く
  const plan = cells.map((c, i) => {
    const a1 = String(c.a1 || '').trim().toUpperCase();
    const m = /^([A-Z]{1,2})(\d+)$/.exec(a1);
    if (!m) throw new Error(`cells[${i}].a1 が不正: "${a1}"`);
    if (!sheetRule.col.test(m[1])) throw new Error(`cells[${i}] 列 ${m[1]} には書けません（GASが書く列）`);
    if (Number(m[2]) < 2) throw new Error(`cells[${i}] 見出し行には書けません`);
    return { a1, value: c.value === undefined || c.value === null ? '' : c.value };
  });
  const before = plan.map(p => ({ a1: p.a1, was: sh.getRange(p.a1).getDisplayValue() }));
  plan.forEach(p => sh.getRange(p.a1).setValue(p.value));
  SpreadsheetApp.flush();
  return { ok: true, file: String(file), sheet: sh.getName(), written: plan.length, before: before };
}

function writeApiRunBatch_() {
  const t0 = Date.now();
  hourlySync();
  return { ok: true, ranAt: nowJst_(), seconds: Math.round((Date.now() - t0) / 1000) };
}

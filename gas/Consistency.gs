/**
 * ============================================================
 *  Consistency.gs - 手動入力の矛盾を洗い出す (v2.13)
 * ============================================================
 *  CleaningBoard と LatestOptions の「人が手で入れる列」を突き合わせ、
 *  つじつまの合わない行を 指摘事項 シートに書き出す。
 *  バッチの最後に走る。
 *
 *  ★同じ内容の行は重複させない。
 *    5列すべて (キー/シート/日付/階/矛盾点) が一致する行が
 *    すでにあれば追記しない。
 *
 *  ★対象は「今日の少し前から、先の予定まで」に限る。
 *    全期間を対象にすると過去の済んだ話で埋まって読めなくなる。
 *    範囲は CONFIG.ISSUE_CHECK の DAYS_BACK / DAYS_AHEAD で変える。
 *
 *  ★解決した指摘は自動では消えない。
 *    直したら行を手で削除する。まだ直っていなければ次のバッチで
 *    また出てくるので、消してしまっても取りこぼさない。
 * ============================================================
 */

/**
 * 矛盾を検査して 指摘事項 シートに追記する。
 * @return {{found:number, added:number}}
 */
function checkConsistency() {
  const K = CONFIG.ISSUE_CHECK || {};
  if (K.ENABLED === false) {
    dlog('矛盾チェックは無効 (CONFIG.ISSUE_CHECK.ENABLED = false)');
    return { found: 0, added: 0 };
  }

  const issues = collectIssues();
  const added = appendIssues(issues);

  dlog(`矛盾チェック: ${issues.length}件検出 / ${added}件を新規追記`);
  return { found: issues.length, added: added };
}

/**
 * 検査本体。指摘の配列を返す (シートには触らない)。
 * @return {Array<{key:string, sheet:string, date:string, room:string, issue:string}>}
 */
function collectIssues() {
  const K = CONFIG.ISSUE_CHECK || {};
  const today = fmtDate(todayJst());
  const from  = addDaysStr(today, -(K.DAYS_BACK  == null ? 3  : K.DAYS_BACK));
  const to    = addDaysStr(today,  (K.DAYS_AHEAD == null ? 60 : K.DAYS_AHEAD));

  const out = [];
  const add = (key, sheet, date, room, issue) =>
    out.push({ key: key, sheet: sheet, date: date, room: room, issue: issue });

  // ── 担当者名の一覧 (打ち間違いの検出に使う) ──────────────
  const known = {};
  webKnownStaffNames().forEach(n => { known[n] = true; });

  // ── CleaningBoard ────────────────────────────────────────
  const C = CONFIG.COL_CLEAN;
  const sh = getSheet(CONFIG.SHEET.CLEANING);
  const last = sh.getLastRow();
  const board = (last > 1) ? sh.getRange(2, 1, last - 1, C.UPDATED_AT).getValues() : [];

  const ARRIVE = ['IN', 'OUT→IN'];
  const occupied = {};      // その夜に宿泊者がいる (日付|階)
  const covered  = {};      // 清掃ボードが行を持っている日付

  board.forEach(row => {
    const d = fmtDate(row[C.DATE - 1]);
    if (!d) return;
    covered[d] = true;
    const room = String(row[C.ROOM - 1] || '').trim();
    if (String(row[C.GUEST_NAME - 1] || '').trim()) occupied[`${d}|${room}`] = true;
  });

  board.forEach(row => {
    const d = fmtDate(row[C.DATE - 1]);
    if (!d || d < from || d > to) return;

    const key   = String(row[C.KEY - 1] || '').trim();
    const room  = String(row[C.ROOM - 1] || '').trim();
    const state = String(row[C.STATE - 1] || '').trim();
    const clean = normStaffName(row[C.STAFF_DAY - 1]);
    const night = normStaffName(row[C.STAFF_NIGHT - 1]);
    const kind  = String(row[C.CLEAN_MANUAL - 1] || '').trim();
    const sets  = numOrZero(row[C.SET_GUESTS - 1]);
    const ppl   = numOrZero(row[C.GUESTS - 1]);
    const guest = String(row[C.GUEST_NAME - 1] || '').trim();
    const arriving = ARRIVE.indexOf(state) >= 0;

    // 担当・種類の抜け
    if (arriving && !clean) add(key, 'CleaningBoard', d, room, '客が入る日なのに清掃担当が空欄');
    if (kind && !clean)     add(key, 'CleaningBoard', d, room, `種類が「${kind}」なのに清掃担当が空欄`);
    // 種類の空欄は、担当がいるか客が入る日のときだけ指摘する
    // (何も無い日まで拾うと全部の空室行が出てしまう)
    if (!kind && (clean || arriving)) {
      add(key, 'CleaningBoard', d, room, clean
        ? `清掃担当「${clean}」がいるのに種類が空欄`
        : '客が入る日なのに種類が空欄');
    }
    if (guest && !night) add(key, 'CleaningBoard', d, room, '宿泊者がいるのに接客担当が空欄');

    // 種類と状態のねじれ
    if (kind === '入替'  && state === '空室')    add(key, 'CleaningBoard', d, room, '種類が入替だが状態は空室');
    if (kind === 'リネン' && state !== '連泊')    add(key, 'CleaningBoard', d, room, `種類がリネンだが状態は${state}`);
    if (kind === 'なし'  && arriving)            add(key, 'CleaningBoard', d, room, '客が入る日なのに種類がなし');

    // 空室なのに担当が残っている (キャンセルの取り残しでよく出る)
    if (!guest && state === '空室' && kind !== '特別' && (clean || night)) {
      add(key, 'CleaningBoard', d, room,
        `空室なのに担当あり (清掃=${clean || '—'} / 接客=${night || '—'})`);
    }

    // セット人数と実人数のずれ
    if (sets > 0 && ppl > 0 && sets !== ppl) {
      add(key, 'CleaningBoard', d, room, `べ(${sets})と泊人(${ppl})が不一致`);
    }

    // 打ち間違い
    [[clean, '清掃'], [night, '接客']].forEach(pair => {
      if (pair[0] && !known[pair[0]]) {
        add(key, 'CleaningBoard', d, room, `${pair[1]}担当「${pair[0]}」がStaffシートに無い`);
      }
    });
  });

  // ── LatestOptions ────────────────────────────────────────
  const O = CONFIG.COL_OPT;
  const osh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const olast = osh.getLastRow();
  const opts = (olast > 1) ? osh.getRange(2, 1, olast - 1, 12).getValues() : [];

  opts.forEach(row => {
    const d = fmtDate(row[O.CHECKIN - 1]);
    if (!d || d < from || d > to) return;

    const room = String(row[O.ROOM - 1] || '').trim();
    const name = String(row[O.GUEST_NAME - 1] || '').trim();
    const deleted = String(row[O.DELETED_FLAG - 1] || '').trim() === '削除';
    const done = String(row[O.HONAMIYA_DONE - 1] || '').trim();
    const key = `${d}_${room}`;

    // 予約が消えたのに、ほなみやには発注済み
    if (deleted && done === '済') {
      add(key, 'LatestOptions', d, room, `予約が消えたのに ほなみや転記済=済 (${name})`);
    }
    if (deleted) return;

    // 食事の予約があるのに、その日その階に在室が無い
    // → 部屋の書き間違い、または予約キャンセルの可能性
    if (covered[d] && room && !occupied[`${d}|${room}`]) {
      add(key, 'LatestOptions', d, room, `食事予約があるが清掃ボードに在室が無い (${name})`);
    }
    if (!numOrZero(row[O.GUESTS - 1])) {
      add(key, 'LatestOptions', d, room, `人数が空欄 (${name})`);
    }
  });

  return out;
}

/**
 * 指摘事項シートに追記する。5列すべてが一致する行は追記しない。
 * @return {number} 追記した行数
 */
function appendIssues(issues) {
  const I = CONFIG.COL_ISSUE;
  const sh = ensureIssueSheet();
  const last = sh.getLastRow();

  const seen = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 5).getValues().forEach(row => {
      const k = issueKey(row[I.KEY - 1], row[I.SHEET - 1],
                         row[I.DATE - 1], row[I.ROOM - 1], row[I.ISSUE - 1]);
      if (k) seen[k] = true;
    });
  }

  const appends = [];
  issues.forEach(it => {
    const k = issueKey(it.key, it.sheet, it.date, it.room, it.issue);
    if (!k || seen[k]) return;
    seen[k] = true;                       // 同一バッチ内の重複も防ぐ
    const row = new Array(5).fill('');
    row[I.KEY - 1]   = it.key;
    row[I.SHEET - 1] = it.sheet;
    row[I.DATE - 1]  = it.date;
    row[I.ROOM - 1]  = it.room;
    row[I.ISSUE - 1] = it.issue;
    appends.push(row);
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, 5).setValues(appends);
  }
  return appends.length;
}

/**
 * 重複判定のキー。5列を連結する。
 * 日付はシートに書くと日付値になるため、必ず fmtDate() を通してから
 * 比較する。文字列のまま比べると毎回別物と判定されて際限なく増える。
 */
function issueKey(key, sheet, date, room, issue) {
  const d = fmtDate(date) || String(date == null ? '' : date).trim();
  const parts = [key, sheet, d, room, issue]
    .map(v => String(v == null ? '' : v).trim());
  if (!parts[4]) return '';            // 矛盾点が空の行は無視
  return parts.join('\u0001');
}

/**
 * 指摘事項シートを用意する (無ければヘッダー付きで作成)
 */
function ensureIssueSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET.ISSUES);
  if (sh) return sh;

  sh = ss.insertSheet(CONFIG.SHEET.ISSUES);
  const header = ['論理削除キー', 'シート', '日付', '階', '矛盾点'];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 150);
  sh.setColumnWidth(2, 120);
  sh.setColumnWidth(5, 420);
  return sh;
}

/**
 * 既知の担当者名。Staff シートを使い、無ければ CleaningBoard から拾う。
 * ★正規化しない。突合は完全一致で、"ゆうｻﾝ" を直すと当番が拾えなくなる。
 */
function webKnownStaffNames() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CONFIG.SHEET.STAFF);
  if (sh && sh.getLastRow() > 1) {
    const S = CONFIG.COL_STAFF;
    return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
      .map(r => String(r[S.NAME - 1] || '').trim())
      .filter(Boolean);
  }
  return Object.keys(collectStaffNames());
}

/**
 * 担当者名の正規化。前後の空白を落とし、「担当なし」の表記は空にする。
 */
function normStaffName(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if ((CONFIG.STAFF.IGNORE || []).indexOf(s) >= 0) return '';
  return s;
}

/**
 * メニューから矛盾チェックだけを実行する
 */
function runConsistencyCheckOnly() {
  const r = checkConsistency();
  Logger.log(`矛盾チェック: ${r.found}件検出 / ${r.added}件を新規追記`);
}

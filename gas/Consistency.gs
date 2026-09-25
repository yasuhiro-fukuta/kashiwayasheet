/**
 * ============================================================
 *  Consistency.gs - 手動入力の矛盾を洗い出す (v2.15)
 * ============================================================
 *  CleaningBoard と LatestOptions の「人が手で入れる列」を突き合わせ、
 *  つじつまの合わない行を 指摘事項 シートに書き出す。
 *  バッチの最後に走る。
 *
 *  ★指摘事項シートの列 (6列):
 *      A プライマリキー … 指摘1件を一意に表す。元行のキー + ルールID
 *      B 論理削除       … 空欄 = いま検出されている / 「削除」= 解消済み
 *      C シート / D 日付 / E 階 / F 矛盾点
 *
 *  ★プライマリキーで突合する。重複行は作らない。
 *    毎回こう更新する:
 *      検出された  → 行が無ければ追記。あれば論理削除を空に戻す(復活)
 *      検出されない → 論理削除に「削除」を立てる (行は消さない)
 *    つまり「論理削除が空の行 = いま検出されている指摘」になる。
 *    ルールを変えたときに古い指摘が残り続ける問題も、これで片付く。
 *
 *  ★対象は「今日の少し前から、先の予定まで」に限る。
 *    全期間を対象にすると過去の済んだ話で埋まって読めなくなる。
 *    範囲は CONFIG.ISSUE_CHECK の DAYS_BACK / DAYS_AHEAD で変える。
 *
 *  ★行は物理削除しない。他のシート (LatestOptions / LodgifyBookings)
 *    と同じ、論理削除の考え方に揃えている。
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
  const r = syncIssues(issues);

  dlog(`矛盾チェック: ${issues.length}件検出 / ` +
       `新規${r.added} 復活${r.revived} 解消${r.deleted} / いま有効${r.active}`);
  return { found: issues.length, added: r.added, revived: r.revived,
           deleted: r.deleted, active: r.active };
}

/**
 * 検査本体。指摘の配列を返す (シートには触らない)。
 *
 * ★設計の前提: 清掃は「日」ではなく「滞在と滞在のあいだ」に割り当てる。
 *
 *   1行だけを見て「客が入る日なのに清掃担当が空欄」と判定すると誤検知する。
 *   売り止めや空室の日が間に入れば到着日に清掃しないことがあるし、
 *   逆に客がいない日に清掃することもあるためである。
 *   実データ (2026-08-13〜09-21) では、清掃の割り当て 55件のうち
 *   17件が宿泊者のいない日に入っていた。
 *
 *   そこで清掃の抜けは「直前のチェックアウト日から到着日までのあいだに
 *   清掃が1日も無いか」で見る。この見方なら売り止めも空室清掃も
 *   自然に吸収できる。過去データでの反例は 0 件だった。
 *
 * ★1行で判定してよいのは「入力そのものの食い違い」だけに絞った。
 *   状態と種類の組み合わせ (入替×空室、リネン×非連泊 など) は
 *   過去データに反例があったため、すべて廃止した。
 *
 * @return {Array<{key:string, sheet:string, date:string, room:string, issue:string}>}
 */
function collectIssues() {
  const K = CONFIG.ISSUE_CHECK || {};
  const R = K.RULES || {};
  const on = (name) => R[name] !== false;

  const today = fmtDate(todayJst());
  const from  = addDaysStr(today, -(K.DAYS_BACK  == null ? 3  : K.DAYS_BACK));
  const to    = addDaysStr(today,  (K.DAYS_AHEAD == null ? 60 : K.DAYS_AHEAD));

  const out = [];
  //  pk = 元行のキー + ルールID。これで指摘1件が一意になる。
  //  同じ行に複数の指摘が出るため、元行のキーだけでは一意にならない。
  const add = (rowKey, ruleId, sheet, date, room, issue) =>
    out.push({
      pk:    `${rowKey}#${ruleId}`,
      sheet: sheet, date: date, room: room, issue: issue,
    });

  const known = {};
  webKnownStaffNames().forEach(n => { known[n] = true; });

  // ── CleaningBoard を読み、階ごとの日付順リストにする ──────
  const C = CONFIG.COL_CLEAN;
  const sh = getSheet(CONFIG.SHEET.CLEANING);
  const last = sh.getLastRow();
  const board = (last > 1) ? sh.getRange(2, 1, last - 1, C.UPDATED_AT).getValues() : [];

  const ARRIVE = ['IN', 'OUT→IN'];
  const byRoom = {};        // 階 → 日付順の行
  const occupied = {};      // その夜に宿泊者がいる (日付|階)
  const covered  = {};      // 清掃ボードが行を持つ日付

  board.forEach(row => {
    const d = fmtDate(row[C.DATE - 1]);
    if (!d) return;
    const room = String(row[C.ROOM - 1] || '').trim();
    if (!room) return;
    covered[d] = true;
    if (String(row[C.GUEST_NAME - 1] || '').trim()) occupied[`${d}|${room}`] = true;
    //  「空欄」と「"-" と明示的に入力」は意味が違う。
    //  空欄 = まだ何も決めていない (指摘の対象)
    //  "-"  = なしと決めた         (指摘の対象にしない)
    //  この区別をしないと、意図して "-" を入れた行まで指摘してしまう。
    const rawClean = String(row[C.STAFF_DAY - 1]    || '').trim();
    const rawNight = String(row[C.STAFF_NIGHT - 1]  || '').trim();
    const rawKind  = String(row[C.CLEAN_MANUAL - 1] || '').trim();

    const item = {
      date:  d,
      key:   String(row[C.KEY - 1] || '').trim(),
      room:  room,
      state: String(row[C.STATE - 1] || '').trim(),
      clean: isNoneMark(rawClean) ? '' : rawClean,
      night: isNoneMark(rawNight) ? '' : rawNight,
      kind:  isNoneMark(rawKind)  ? '' : rawKind,
      cleanBlank: rawClean === '',
      nightBlank: rawNight === '',
      kindBlank:  rawKind  === '',
      sets:  numOrZero(row[C.SET_GUESTS - 1]),
      ppl:   numOrZero(row[C.GUESTS - 1]),
      guest: String(row[C.GUEST_NAME - 1] || '').trim(),
    };
    (byRoom[room] = byRoom[room] || []).push(item);
  });
  Object.keys(byRoom).forEach(r =>
    byRoom[r].sort((a, b) => (a.date < b.date ? -1 : 1)));

  // ── 区間で見る検査: 滞在と滞在のあいだに清掃があるか ────────
  if (on('cleanGap')) {
    Object.keys(byRoom).forEach(room => {
      const list = byRoom[room];
      let prevOut = -1;                       // 直前にチェックアウトがあった位置

      list.forEach((it, i) => {
        if (ARRIVE.indexOf(it.state) >= 0) {
          // 直前の退室が分からない場合は判定しない (データの先頭など)
          if (prevOut >= 0 && it.date >= from && it.date <= to) {
            const win = list.slice(prevOut, i + 1);
            const cleaned = win.some(x => x.clean);
            if (!cleaned) {
              const span = (win.length === 1)
                ? it.date
                : `${win[0].date}〜${it.date}`;
              add(it.key, 'cleanGap', 'CleaningBoard', it.date, room,
                `前の退室から到着まで清掃が1日も入っていない (${span}, ${win.length}日)`);
            }
          }
        }
        if (it.state.indexOf('OUT') >= 0) prevOut = i;
      });
    });
  }

  // ── 1行で見る検査: 入力そのものの食い違いだけ ──────────────
  Object.keys(byRoom).forEach(room => {
    byRoom[room].forEach(it => {
      if (it.date < from || it.date > to) return;

      // 「なし」と明示した行は対象外。空欄のときだけ指摘する。
      if (on('kindMissing') && it.clean && it.kindBlank) {
        add(it.key, 'kindMissing', 'CleaningBoard', it.date, room,
          `清掃担当「${it.clean}」がいるのに種類が空欄`);
      }
      if (on('cleanerMissing') && it.kind && it.cleanBlank) {
        add(it.key, 'cleanerMissing', 'CleaningBoard', it.date, room,
          `種類が「${it.kind}」なのに清掃担当が空欄`);
      }
      if (on('nightMissing') && ARRIVE.indexOf(it.state) >= 0 && it.nightBlank) {
        add(it.key, 'nightMissing', 'CleaningBoard', it.date, room, '到着日なのに接客担当が空欄');
      }
      if (on('setsMismatch') && it.sets > 0 && it.ppl > 0 && it.sets !== it.ppl) {
        add(it.key, 'setsMismatch', 'CleaningBoard', it.date, room,
          `べ(${it.sets})と泊人(${it.ppl})が不一致`);
      }
      if (on('unknownStaff')) {
        [[it.clean, '清掃'], [it.night, '接客']].forEach(p => {
          if (p[0] && !known[p[0]]) {
            // 清掃と接客で2件出るため、ルールIDに役割を足して一意にする
            add(it.key, `unknownStaff.${p[1]}`, 'CleaningBoard', it.date, room,
              `${p[1]}担当「${p[0]}」がStaffシートに無い`);
          }
        });
      }
    });
  });

  // ── LatestOptions ────────────────────────────────────────
  //  こちらは日付単位で意味が閉じているので1行で判定してよい。
  const O = CONFIG.COL_OPT;
  const osh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const olast = osh.getLastRow();
  const opts = (olast > 1) ? osh.getRange(2, 1, olast - 1, 12).getValues() : [];

  //  有効な行がある (宿泊日, 階) を先に集めておく。
  //  フォームを出し直すと古い行に削除フラグが立つ。これは
  //  キャンセルではなく再提出なので、指摘してはいけない。
  const optActive = {};
  opts.forEach(row => {
    if (String(row[O.DELETED_FLAG - 1] || '').trim() === '削除') return;
    const d = fmtDate(row[O.CHECKIN - 1]);
    const room = String(row[O.ROOM - 1] || '').trim();
    if (d && room) optActive[`${d}|${room}`] = true;
  });

  opts.forEach(row => {
    const d = fmtDate(row[O.CHECKIN - 1]);
    if (!d || d < from || d > to) return;

    const room = String(row[O.ROOM - 1] || '').trim();
    const name = String(row[O.GUEST_NAME - 1] || '').trim();
    const deleted = String(row[O.DELETED_FLAG - 1] || '').trim() === '削除';
    const done = String(row[O.HONAMIYA_DONE - 1] || '').trim();
    //  同じ (日付, 階) に複数のフォーム回答があるため、氏名まで入れる。
    //  (実例: 2026-09-18 1F に Ellen さんと Isidro さんの2件)
    //  さらに同じ人が同じ日・同じ階に出し直すこともあるので、
    //  フォーム送信日時まで入れてようやく一意になる。
    //  (実例: 2026-08-24 1F の Simone Perissin さんが2回提出)
    const sent = fmtDateTime(row[O.FORM_TS - 1]);
    const key = sent
      ? `${d}_${room}_${name}@${sent}`
      : `${d}_${room}_${name}`;

    if (on('orderedButGone') && deleted && done === '済' && !optActive[`${d}|${room}`]) {
      add(key, 'orderedButGone', 'LatestOptions', d, room, `予約が消えたのに ほなみや転記済=済 (${name})`);
    }
    if (deleted) return;

    if (on('mealNoStay') && covered[d] && room && !occupied[`${d}|${room}`]) {
      add(key, 'mealNoStay', 'LatestOptions', d, room, `食事予約があるが清掃ボードに在室が無い (${name})`);
    }
    if (on('guestsMissing') && !numOrZero(row[O.GUESTS - 1])) {
      add(key, 'guestsMissing', 'LatestOptions', d, room, `人数が空欄 (${name})`);
    }
  });

  return out;
}

/**
 * 指摘事項シートを検出結果に合わせて更新する。
 *
 *   検出された   → 行が無ければ追記。あれば論理削除を空に戻す (復活)
 *   検出されない → 論理削除に「削除」を立てる (行は消さない)
 *
 * 突合はプライマリキーだけで行う。日付や文言の表記ゆれに左右されない。
 * (以前は5列すべてを連結して比較していたが、シートに書いた日付が
 *  日付値に変換されるため扱いが面倒だった)
 *
 * @return {{added:number, revived:number, deleted:number, active:number}}
 */
function syncIssues(issues) {
  const I = CONFIG.COL_ISSUE;
  const W = I.ISSUE;                       // 列数 = 6
  const sh = ensureIssueSheet();
  const last = sh.getLastRow();

  // 今回検出したもの (同一バッチ内でキーが重複したら先勝ち)
  const found = {};
  issues.forEach(it => { if (!found[it.pk]) found[it.pk] = it; });

  const existing = (last > 1) ? sh.getRange(2, 1, last - 1, W).getValues() : [];
  const res = { added: 0, revived: 0, deleted: 0, active: 0 };

  const seen = {};
  existing.forEach(row => {
    const pk = String(row[I.KEY - 1] || '').trim();
    if (!pk) return;
    seen[pk] = true;
    const wasDeleted = String(row[I.DELETED - 1] || '').trim() === '削除';

    if (found[pk]) {
      if (wasDeleted) { row[I.DELETED - 1] = ''; res.revived++; }   // 再発したので復活
      res.active++;
    } else if (!wasDeleted) {
      row[I.DELETED - 1] = '削除';                                   // 解消したので論理削除
      res.deleted++;
    }
  });

  const appends = [];
  Object.keys(found).forEach(pk => {
    if (seen[pk]) return;
    const it = found[pk];
    const row = new Array(W).fill('');
    row[I.KEY - 1]     = pk;
    row[I.DELETED - 1] = '';
    row[I.SHEET - 1]   = it.sheet;
    row[I.DATE - 1]    = it.date;
    row[I.ROOM - 1]    = it.room;
    row[I.ISSUE - 1]   = it.issue;
    appends.push(row);
    res.added++; res.active++;
  });

  if (existing.length) sh.getRange(2, 1, existing.length, W).setValues(existing);
  if (appends.length)  sh.getRange(existing.length + 2, 1, appends.length, W).setValues(appends);

  return res;
}

/**
 * 指摘事項シートを用意する。
 *
 * ★旧レイアウト (5列: 論理削除キー/シート/日付/階/矛盾点) を見つけたら
 *   自動で移行する。A列の見出しを「プライマリキー」に直し、
 *   その右に「論理削除」列を1本差し込む。
 *   既存の行は消さない。次の実行で検出されなければ論理削除が立つ。
 *   移行後にもう一度実行しても何も起きない (見出しで判定するため)。
 */
function ensureIssueSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const header = ['プライマリキー', '論理削除', 'シート', '日付', '階', '矛盾点'];
  let sh = ss.getSheetByName(CONFIG.SHEET.ISSUES);

  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET.ISSUES);
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#e8eaed');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 220);
    sh.setColumnWidth(2, 80);
    sh.setColumnWidth(3, 120);
    sh.setColumnWidth(6, 420);
    return sh;
  }

  const width = Math.max(sh.getLastColumn(), 1);
  const head = sh.getRange(1, 1, 1, width).getValues()[0]
    .map(v => String(v == null ? '' : v).trim());

  // 論理削除列がまだ無い = 旧レイアウト
  if (head[1] !== '論理削除') {
    sh.insertColumnAfter(1);
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#e8eaed');
    sh.setColumnWidth(1, 220);
    sh.setColumnWidth(2, 80);
    Logger.log('指摘事項シートを6列レイアウトへ移行しました (論理削除列を追加)。');
  }
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
 * 「なし」を意味する入力かどうか ("-" など)。
 * CONFIG.STAFF.IGNORE の値をそのまま流用する。
 */
function isNoneMark(s) {
  const v = String(s == null ? '' : s).trim();
  if (!v) return false;
  return (CONFIG.STAFF.IGNORE || []).indexOf(v) >= 0;
}

/**
 * 担当者名の正規化。前後の空白を落とし、「担当なし」の表記は空にする。
 */
function normStaffName(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (isNoneMark(s)) return '';
  return s;
}

/**
 * メニューから矛盾チェックだけを実行する
 */
function runConsistencyCheckOnly() {
  const r = checkConsistency();
  Logger.log(`矛盾チェック: ${r.found}件検出 / ${r.added}件を新規追記`);
}

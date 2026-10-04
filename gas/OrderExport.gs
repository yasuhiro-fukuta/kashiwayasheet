/**
 * ============================================================
 *  OrderExport.gs — ほなみや注文確認票への転記  v2.22
 * ============================================================
 *  LatestOptions の内容を、ほなみやさんと共有している
 *  「柏屋注文確認票」へ一覧として書き出す。
 *  毎時バッチ (runBatch) の最後に走る。
 *
 *  ── 大前提 ────────────────────────────────────────────────
 *  転記先は **Googleスプレッドシート形式** でなければならない。
 *  元ファイルは .xlsx (Excel) で、Apps Script の SpreadsheetApp は
 *  .xlsx を開けない。ほなみやさんに
 *    ファイル → Google スプレッドシートとして保存
 *  で変換してもらい、変換後の新しいIDを
 *    setOrderExportTargetId('変換後のID')
 *  で1回だけ登録する。IDはコードに書かない (リポジトリが公開のため)。
 *
 *  ── 絶対にやらないこと ────────────────────────────────────
 *  ・月ごとのカレンダー表 (「R8　１０月」など) に書き込まない。
 *    あちらはほなみやさんが手で書く領域。
 *    このスクリプトが触るのは CONFIG.ORDER_EXPORT.SHEET_NAME の
 *    1タブだけで、そのタブも毎回まるごと書き換える。
 *  ・転記先が開けない / 権限が無い / まだ .xlsx のままでも
 *    例外を投げてバッチを止めない。ログに理由を出して続行する。
 * ============================================================
 */

// ── 入口 ────────────────────────────────────────────────────

/** メニュー・バッチから呼ぶ。失敗してもバッチを止めない。 */
function runOrderExportOnly() {
  const r = exportOrdersToHonamiya(nowJst());
  Logger.log(formatOrderExportResult_(r));
  return r;
}

/**
 * LatestOptions → 注文確認票 へ転記する。
 * @param {Date} now
 * @return {Object} {ok, skipped, reason, written, range, targetName}
 */
function exportOrdersToHonamiya(now) {
  const E = CONFIG.ORDER_EXPORT;
  if (!E.ENABLED) {
    return { ok: false, skipped: true, reason: 'CONFIG.ORDER_EXPORT.ENABLED が false', written: 0 };
  }

  const id = PropertiesService.getScriptProperties().getProperty(E.PROP_TARGET_ID);
  if (!id) {
    return {
      ok: false, skipped: true, written: 0,
      reason: '転記先IDが未設定。setOrderExportTargetId(\'変換後のID\') を1回実行してください',
    };
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    //  .xlsx のまま / 権限が無い / IDが違う のどれか。
    //  どれでもバッチは止めず、原因がわかる形でログに残す。
    return {
      ok: false, skipped: true, written: 0,
      reason: '転記先を開けませんでした。'
        + 'Googleスプレッドシート形式に変換されているか、'
        + 'このスクリプトの実行ユーザーに編集権限があるかを確認してください。'
        + ` (ID=${id} / ${e.message || e})`,
    };
  }

  const win  = orderExportWindow_(now);
  const rows = collectOrderExportRows(readOptionRowsForExport_(), win);

  let sh;
  try {
    sh = ss.getSheetByName(E.SHEET_NAME) || ss.insertSheet(E.SHEET_NAME);
  } catch (e) {
    return {
      ok: false, skipped: true, written: 0,
      reason: `タブ「${E.SHEET_NAME}」を用意できませんでした (${e.message || e})`,
    };
  }

  writeOrderExportSheet_(sh, rows, win, now);

  return {
    ok: true, skipped: false, written: rows.length,
    range: `${win.from} 〜 ${win.to}`,
    targetName: ss.getName(),
    sheetName: E.SHEET_NAME,
  };
}

// ── 読み取り ────────────────────────────────────────────────

/** LatestOptions を素の配列にする。論理削除された行は返さない。 */
function readOptionRowsForExport_() {
  const sh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const last = sh.getLastRow();
  if (last <= 1) return [];

  const C = CONFIG.COL_OPT;
  const vals = sh.getRange(2, 1, last - 1, C.FORM_JSON).getValues();

  const out = [];
  vals.forEach(row => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    //  ★日付は fmtDate を必ず通す。シートのTZが America/Los_Angeles
    //    なので生の Date を使うと1日ずれる (HANDOFF.md 参照)。
    const d = fmtDate(row[C.CHECKIN - 1]);
    if (!d) return;
    const ts = toDate(row[C.FORM_TS - 1]);
    out.push({
      checkin:   d,
      room:      String(row[C.ROOM - 1]        || '').trim(),
      guestName: String(row[C.GUEST_NAME - 1]  || '').trim(),
      guests:    String(row[C.GUESTS - 1]      || '').trim(),
      meal:      String(row[C.MEAL_SUMMARY - 1]|| '').trim(),
      option:    String(row[C.OPT_SUMMARY - 1] || '').trim(),
      other:     String(row[C.OTHER_REQ - 1]   || '').trim(),
      formTsMs:  (ts && !isNaN(ts.getTime())) ? ts.getTime() : 0,
      formTs:    ts && !isNaN(ts.getTime()) ? fmtDateTime(ts) : '',
    });
  });
  return out;
}

// ── 計算本体 (シートに触らない。テストから直接呼べる) ──────────

/**
 * 転記する期間を出す。当月の1日 〜 MONTHS_AHEAD か月後の月末。
 * @return {{from: string, to: string, months: Array<string>}}
 */
function orderExportWindow_(now) {
  const ahead = Math.max(0, CONFIG.ORDER_EXPORT.MONTHS_AHEAD);
  const base  = now || nowJst();
  const y = base.getFullYear(), m = base.getMonth();

  const from = Utilities.formatDate(new Date(y, m, 1), CONFIG.TZ, 'yyyy-MM-dd');
  //  翌月以降の「0日」= 前月の末日
  const to   = Utilities.formatDate(new Date(y, m + ahead + 1, 0), CONFIG.TZ, 'yyyy-MM-dd');

  const months = [];
  for (let i = 0; i <= ahead; i++) {
    months.push(Utilities.formatDate(new Date(y, m + i, 1), CONFIG.TZ, 'yyyy-MM'));
  }
  return { from: from, to: to, months: months };
}

/**
 * 転記する行を選んで並べる。
 *  ・期間内 (宿泊日が from〜to)
 *  ・INCLUDE_WHEN の条件を満たす
 *  ・同じ (宿泊日, 部屋, 宿泊者名) が複数あればフォーム送信が新しい方を採る
 *    (再提出された古い行を二重に出さないため)
 *  ・宿泊日 → 部屋 の順に並べる
 */
function collectOrderExportRows(rows, win) {
  const E = CONFIG.ORDER_EXPORT;
  const w = win || orderExportWindow_(nowJst());

  const keep = {};
  rows.forEach(r => {
    if (r.checkin < w.from || r.checkin > w.to) return;

    const hasMeal = !!r.meal;
    const hasOpt  = !!r.option;
    if (E.INCLUDE_WHEN === 'meal_only'      && !hasMeal)            return;
    if (E.INCLUDE_WHEN === 'meal_or_option' && !hasMeal && !hasOpt) return;

    const key = `${r.checkin}|${r.room}|${r.guestName}`;
    const cur = keep[key];
    if (!cur || r.formTsMs >= cur.formTsMs) keep[key] = r;
  });

  return Object.keys(keep).map(k => keep[k]).sort((a, b) => {
    if (a.checkin !== b.checkin) return a.checkin < b.checkin ? -1 : 1;
    if (a.room    !== b.room)    return a.room    < b.room    ? -1 : 1;
    return a.guestName < b.guestName ? -1 : (a.guestName > b.guestName ? 1 : 0);
  });
}

/** 1行分を、シートに書く配列にする。 */
function orderExportRowValues_(r) {
  return [
    r.checkin,
    weekdayJa(isoWeekday(r.checkin)),
    r.room,
    r.guestName,
    r.guests,
    r.meal,
    r.option,
    r.other,
    r.formTs,
  ];
}

// ── 書き込み ────────────────────────────────────────────────

/**
 * 専用タブをまるごと書き換える。
 *  ★このタブ以外には触らない。
 *  ★行数が前回より減ったときに古い行が残らないよう、
 *    書く前に既存の中身をクリアする。
 */
function writeOrderExportSheet_(sh, rows, win, now) {
  const E = CONFIG.ORDER_EXPORT;
  const width = E.HEADER.length;

  sh.clear();

  const head = [];
  head.push([`柏屋 食事・オプション注文一覧 (${win.from} 〜 ${win.to})`]
    .concat(new Array(width - 1).fill('')));
  head.push([`最終更新 ${fmtDateTime(now || nowJst())}  /  ${rows.length}件`]
    .concat(new Array(width - 1).fill('')));
  if (E.NOTICE) {
    head.push([E.NOTICE].concat(new Array(width - 1).fill('')));
  }
  head.push(E.HEADER.slice());

  const body = rows.map(orderExportRowValues_);
  const all  = head.concat(body);

  sh.getRange(1, 1, all.length, width).setValues(all);

  //  見出しを目立たせる。中身の書式はいじらない。
  const headerRow = head.length;
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setFontSize(12);
  sh.getRange(headerRow, 1, 1, width).setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(headerRow);

  //  宿泊日は文字列で書いている。転記先のTZに引きずられないため。
  sh.getRange(headerRow + 1, 1, Math.max(1, body.length), 1)
    .setNumberFormat('@');
}

// ── ログ ────────────────────────────────────────────────────

function formatOrderExportResult_(r) {
  if (r.ok) {
    return `注文確認票へ転記: ${r.written}件 (${r.range}) → 「${r.targetName}」の`
      + `「${r.sheetName}」タブ`;
  }
  return `注文確認票への転記をスキップ: ${r.reason}`;
}

/**
 * 転記せずに「何件・どの行が出るか」だけを確認する。
 * 転記先の設定前でも実行できる。
 */
function dumpOrderExport() {
  const now = nowJst();
  const win = orderExportWindow_(now);
  const all = readOptionRowsForExport_();
  const rows = collectOrderExportRows(all, win);

  const L = [];
  L.push('════════ 注文確認票への転記 (確認のみ・書き込みなし) ════════');
  L.push(`対象期間: ${win.from} 〜 ${win.to}  (${win.months.join(', ')})`);
  L.push(`LatestOptions 有効行: ${all.length}件 → 転記対象: ${rows.length}件`);
  L.push(`行を書く条件: ${CONFIG.ORDER_EXPORT.INCLUDE_WHEN}`);

  const id = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.ORDER_EXPORT.PROP_TARGET_ID);
  if (!id) {
    L.push('転記先: ★未設定。setOrderExportTargetId(\'変換後のID\') を1回実行してください');
  } else {
    try {
      const ss = SpreadsheetApp.openById(id);
      L.push(`転記先: ${ss.getName()} (開けました)`);
    } catch (e) {
      L.push(`転記先: ★開けません — ${e.message || e}`);
      L.push('        .xlsx のままになっていないか、編集権限があるかを確認してください。');
    }
  }

  L.push('');
  L.push(CONFIG.ORDER_EXPORT.HEADER.join(' | '));
  rows.forEach(r => L.push(orderExportRowValues_(r).join(' | ')));

  Logger.log(L.join('\n'));
  return rows;
}

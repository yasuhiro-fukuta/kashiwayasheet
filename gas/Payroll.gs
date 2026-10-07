/**
 * ============================================================
 *  Payroll.gs — 業務委託料(給料)の月次計算  v2.21
 * ============================================================
 *  毎月やる作業なのでスプレッドシート側で完結させる。
 *
 *  使い方:
 *    メニュー「柏屋同期」→「給料を計算 (前月)」/「給料を計算 (当月)」
 *    または エディタから calcStaffPay('2026-10') を実行してログを見る。
 *
 *  読むシートと書くシート:
 *    読む … CleaningBoard (A列 清掃担当 / B列 種類 / D列 接客担当 /
 *                          F列 泊人 / G列 状態 / H列 日付 / J列 部屋 /
 *                          R列 食事)
 *           特 (A列 対応者 / B列 完了日 / C列 pt / D列 内容)
 *    書く … 何も書かない。ログに出すだけ。
 *           ★A〜D列は人の領域なので読み取り専用を厳守する。
 *
 *  金額の根拠は CONFIG.PAYROLL (契約書の数字をそのまま置いてある)。
 *  契約が変わったらコードではなく Config.gs を直すこと。
 *
 *  ── 契約書が一意に読めない箇所 ──────────────────────────────
 *   特別報酬「その値×200円」の「その値」が
 *     (a) 人数そのもの   (5名 → 1,000円)
 *     (b) 4人を超えた分  (5名 →   200円)
 *   のどちらか確定できない。CONFIG.PAYROLL.BONUS.BASE で切り替え、
 *   ログには必ず両方の金額を併記する。確定したら BASE を合わせること。
 * ============================================================
 */

// ── 入口 ────────────────────────────────────────────────────

/** 前月分を計算してログに出す。 */
function calcStaffPayPrevMonth() {
  const d = todayJst();
  const ym = Utilities.formatDate(
    new Date(d.getFullYear(), d.getMonth() - 1, 1), CONFIG.TZ, 'yyyy-MM');
  return calcStaffPay(ym);
}

/** 当月分を計算してログに出す (月中は見込み額)。 */
function calcStaffPayThisMonth() {
  return calcStaffPay(Utilities.formatDate(todayJst(), CONFIG.TZ, 'yyyy-MM'));
}

/**
 * 指定月の業務委託料を計算してログに出す。
 * @param {string} ym 'yyyy-MM'
 * @return {Object} 集計結果 (テストから使う)
 */
function calcStaffPay(ym) {
  const month = normalizePayrollMonth_(ym);
  const board = readBoardForPayroll_();
  //  ★徹底清掃は「特」シートを読まない (発注者指示)。
  //    清掃ボードで両階とも「特別」の日からだけ出す。
  const deep  = CONFIG.PAYROLL.DEEP.USE_SHEET ? readDeepCleanForPayroll_() : [];
  const opts  = CONFIG.PAYROLL.CHECKIN.USE_LATEST_OPTIONS ? readOptionsForPayroll_() : [];

  //  ほなみや注文確認票。読めなくても計算は止めず、理由を警告に出す。
  let order = { ok: false, dates: {}, reason: '設定で無効' };
  if (CONFIG.PAYROLL.CHECKIN.USE_ORDER_SHEET) {
    try {
      order = readOrderSheetDinners_(month);
    } catch (e) {
      order = { ok: false, dates: {}, reason: String(e.message || e) };
    }
  }

  const res = computeStaffPay(board, deep, month, opts, order);
  logStaffPay_(res);
  return res;
}

// ── 読み取り ────────────────────────────────────────────────

/**
 * CleaningBoard を計算用の素の配列にする。
 * ★日付は H列の「表示文字列」を使う。シートのTZが America/Los_Angeles
 *   なので生の Date で読むと1日ずれる (HANDOFF.md 参照)。
 */
function readBoardForPayroll_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.CLEANING);
  if (!sh) throw new Error('CleaningBoard シートが見つかりません');
  const last = sh.getLastRow();
  if (last < 2) return [];

  const C = CONFIG.COL_CLEAN;
  //  U列(清掃達成率) と V列(清掃やり直した箇所) まで読む。
  //  まだ列が無いシートでも落ちないように実際の列数で止める。
  const width = Math.min(Math.max(sh.getLastColumn(), C.UPDATED_AT), C.SPECIAL_SPOT);
  const rows = sh.getRange(2, 1, last - 1, width).getDisplayValues();

  return rows.map(r => ({
    date:      String(r[C.DATE - 1]         || '').trim(),
    room:      String(r[C.ROOM - 1]         || '').trim(),
    cleaner:   String(r[C.STAFF_DAY - 1]    || '').trim(),
    cleanKind: String(r[C.CLEAN_MANUAL - 1] || '').trim(),
    setGuests: String(r[C.SET_GUESTS - 1]   || '').trim(),
    server:    String(r[C.STAFF_NIGHT - 1]  || '').trim(),
    guests:    String(r[C.GUESTS - 1]       || '').trim(),
    state:     String(r[C.STATE - 1]        || '').trim(),
    guestName: String(r[C.GUEST_NAME - 1]   || '').trim(),
    meal:      String(r[C.MEAL - 1]         || '').trim(),
    cleanRate: String(r[C.CLEAN_RATE - 1]   || '').trim(),   // U 手動
    cleanRedo: String(r[C.CLEAN_REDO - 1]   || '').trim(),   // V 手動
    nightHalf: String(r[C.NIGHT_HALF - 1]   || '').trim(),   // W 手動
    spotWork:  String(r[C.SPECIAL_SPOT - 1] || '').trim(),   // X 手動 (金額には効かせない)
  })).filter(r => r.date);
}

/** 特シート (客室徹底清掃業務) を読む。 */
function readDeepCleanForPayroll_() {
  const name = CONFIG.PAYROLL.DEEP.SHEET;
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];

  const rows = sh.getRange(2, 1, last - 1, 4).getDisplayValues();
  return rows.map(r => ({
    assignee: String(r[0] || '').trim(),
    doneDate: String(r[1] || '').trim(),
    pt:       String(r[2] || '').trim(),
    task:     String(r[3] || '').trim(),
  })).filter(r => r.task || r.assignee);
}

/**
 * LatestOptions を読む (チェックイン対応の仕出し判定用)。
 *  ★清掃ボードの食事列(R)は、フォームの行が滞在に突合できたときしか
 *    埋まらない。突合に失敗した注文を取りこぼすので、こちらも直接見る。
 *  論理削除された行は返さない。
 */
function readOptionsForPayroll_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.LATEST_OPT);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];

  const C = CONFIG.COL_OPT;
  const rows = sh.getRange(2, 1, last - 1, C.FORM_JSON).getValues();

  const out = [];
  rows.forEach(r => {
    if (r[C.DELETED_FLAG - 1] === '削除') return;
    //  ★日付は fmtDate を必ず通す。シートのTZが America/Los_Angeles の
    //    ため生の Date だと1日ずれる (HANDOFF.md 参照)。
    const d = fmtDate(r[C.CHECKIN - 1]);
    if (!d) return;
    out.push({
      checkin:   d,
      room:      String(r[C.ROOM - 1]         || '').trim(),
      guestName: String(r[C.GUEST_NAME - 1]   || '').trim(),
      meal:      String(r[C.MEAL_SUMMARY - 1] || '').trim(),
    });
  });
  return out;
}

// ── ほなみや注文確認票の読み取り (仕出し判定の3つ目の情報源) ──────
//  読むだけ。書き込みは一切しない。

/**
 * タブ名から対象年月 ('yyyy-MM') を割り出す。
 *  'R8　１０月' → 2026-10   (R8 = 令和8年 = 2026年)
 *  '９月'       → ''        (年が決まらないので対象外)
 */
function orderSheetMonthOf_(name) {
  const O = CONFIG.PAYROLL.ORDER_SHEET;
  const s = toHalfWidth(String(name || ''));
  const ym = s.match(O.YEAR_PATTERN);
  const mm = s.match(O.MONTH_PATTERN);
  if (!ym || !mm) return '';
  const year  = O.REIWA_BASE_YEAR + Number(ym[1]);
  const month = Number(mm[1]);
  if (!(month >= 1 && month <= 12)) return '';
  return `${year}-${('0' + month).slice(-2)}`;
}

/**
 * 対象月のタブを「全部」探す。
 *  ★1つだけ返すと誤読する。注文確認票には
 *      「R8　１０月」… 本体のカレンダー表
 *      「R8 10月」   … メモ書きの小さなタブ
 *    のように、同じ月に解決するタブが複数ある。先に見つかった方を
 *    返すとタブの並び順しだいで中身の無い方を読んでしまう。
 *    全部読んで足し合わせる。表の無いタブは何も足さないので無害。
 */
function findOrderSheetsForMonth_(ss, month) {
  const O = CONFIG.PAYROLL.ORDER_SHEET;
  const fixed = O.SHEET_OVERRIDES[month];
  if (fixed) {
    const sh = ss.getSheetByName(fixed);
    return sh ? [sh] : [];
  }
  return ss.getSheets().filter(sh => orderSheetMonthOf_(sh.getName()) === month);
}

/**
 * 1枚のシートを「月ごとのブロック」に切り分ける。
 *
 *  ★一次転記シートは1タブに複数の月を縦に並べる運用になった
 *    (2026-10)。先頭の年月だけ見ると、下に並んだ別の月の注文を
 *    先頭の月の日付として読んでしまう。必ずブロックに分けること。
 *
 *  ブロックの始まり … 「R8年10月」のような年月が入ったセルがある行
 *  ブロックの見出し … その後に最初に現れる「日付」「注文品」を含む行
 *  ブロックの終わり … 次のブロックの始まり (無ければシートの末尾)
 *
 *  @return {Array<{month, headerRow, end, pairs:Array<{date,name,item,qty}>}>}
 */
function parseOrderSheetBlocks(values) {
  const O = CONFIG.PAYROLL.ORDER_SHEET;
  const blocks = [];
  let cur = null;

  for (let r = 0; r < values.length; r++) {
    const row = values[r] || [];
    const cells = row.map(v => String(v || '').trim());

    //  年月のセルがあれば新しいブロックの始まり
    for (let c = 0; c < cells.length; c++) {
      const m = orderSheetMonthOf_(cells[c]);
      if (m) {
        cur = { month: m, headerRow: -1, start: r, end: values.length, pairs: [] };
        blocks.push(cur);
        break;
      }
    }

    //  見出し行 (そのブロックで最初に出てきたものだけ採る)
    if (!cur || cur.headerRow >= 0) continue;
    const dateCols = [], itemCols = [], nameCols = [];
    cells.forEach((v, i) => {
      if (v === O.HEADER_DATE) dateCols.push(i);
      if (v === O.HEADER_ITEM) itemCols.push(i);
      if (v === O.HEADER_NAME) nameCols.push(i);
    });
    if (!dateCols.length || !itemCols.length) continue;

    cur.headerRow = r;
    dateCols.forEach(d => {
      //  その日付列より右で最初の注文品列を組にする (1階ぶん / 2階ぶん)
      const item = itemCols.filter(i => i > d).sort((a, b) => a - b)[0];
      if (item === undefined) return;
      const name = nameCols.filter(i => i > d && i < item).sort((a, b) => b - a)[0];
      cur.pairs.push({
        date: d,
        name: (name !== undefined) ? name : item - 1,
        item: item,
        qty:  item + 1,
      });
    });
  }

  for (let i = 0; i < blocks.length - 1; i++) blocks[i].end = blocks[i + 1].start;
  return blocks.filter(b => b.headerRow >= 0 && b.pairs.length);
}

/**
 * 1枚のシートから、指定月の注文を1行ずつ取り出す。
 *  @return {Array<{date, floor, name, item, qty}>}
 *    floor は列の組の順番から決める (1組目=1F / 2組目=2F)。
 */
function readOrderSheetEntries(values, month) {
  return scanOrderSheet(values, month).entries;
}

/**
 * 1枚のシートから、指定月の注文と「その中身がどのセルにあるか」を取り出す。
 *
 *  ★行・列まで返すのは、注記 (メモ) を正しいセルに付けるため。
 *    値を書き換えるのではなく、そのセルに注記を添える使い方をする。
 *
 *  @return {{
 *    entries: Array<{date, floor, name, item, qty, row, dateCol, nameCol, itemCol, qtyCol}>,
 *    dayCell: Object   // 'yyyy-MM-dd|1F' → {row, col}  日付セルの位置 (すべて1始まり)
 *  }}
 *    floor は列の組の順番から決める (1組目=1F / 2組目=2F)。
 */
function scanOrderSheet(values, month) {
  const O = CONFIG.PAYROLL.ORDER_SHEET;
  const blocks = parseOrderSheetBlocks(values).filter(b => b.month === month);
  const out = [];
  const dayCell = {};

  blocks.forEach(b => {
    b.pairs.forEach((pair, idx) => {
      const floor = CONFIG.CLEANING.ROOMS[idx] || `組${idx + 1}`;
      let day = 0, name = '';
      for (let r = b.headerRow + 1; r < b.end; r++) {
        const row = values[r] || [];
        const dcell = toHalfWidth(String(row[pair.date] || '').trim());
        const m = dcell.match(O.DAY_PATTERN);
        if (m) {
          const n = Number(m[1]);
          //  日付が変わったら名前も引き継ぎを切る
          if (n >= 1 && n <= 31 && n !== day) {
            day = n; name = '';
            //  その日の注記を付ける先。最初に出てきたセルを使う
            //  (結合セルだと値が入るのは左上だけなので、そこが先頭になる)
            const dk = `${month}-${('0' + day).slice(-2)}|${floor}`;
            if (!dayCell[dk]) dayCell[dk] = { row: r + 1, col: pair.date + 1 };
          }
        }
        if (!day) continue;

        const nm = String(row[pair.name] || '').trim();
        if (nm) name = nm;

        const item = String(row[pair.item] || '').trim();
        if (!item) continue;
        out.push({
          date:  `${month}-${('0' + day).slice(-2)}`,
          floor: floor,
          name:  name,
          item:  item,
          qty:   String(row[pair.qty] || '').trim(),
          //  ★セルの位置 (1始まり)。突合の結果には影響させない。
          row:     r + 1,
          dateCol: pair.date + 1,
          nameCol: pair.name + 1,
          itemCol: pair.item + 1,
          qtyCol:  pair.qty  + 1,
        });
      }
    });
  });

  out.sort((a, b) => (a.date + a.floor) < (b.date + b.floor) ? -1 : 1);
  return { entries: out, dayCell: dayCell };
}

/**
 * 表の中身から「夕食がある日」を集める。シートに触らないのでテストできる。
 *  ・月ごとのブロックに分けてから、指定月のブロックだけを読む。
 *  ・日付セルは品目が複数ある日は空欄になるので直前の日を引き継ぐ。
 *  ・1階ぶん・2階ぶんのどちらでも夕食があればその日は夕食あり。
 */
function collectOrderSheetDinners(values, month) {
  const out = {};
  readOrderSheetEntries(values, month).forEach(e => {
    if (classifyMealItem_(e.item) !== 'dinner') return;
    if (!out[e.date]) out[e.date] = [];
    if (out[e.date].indexOf(e.item) < 0) out[e.date].push(e.item);
  });
  return out;
}

/**
 * 1枚のシートから「夕食がある日」を拾う。
 *  @return {{ok, dates, sheetName, reason}}
 */
function readOneOrderSheet_(sh, month, label) {
  const name = `${label}「${sh.getName()}」`;
  const last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2 || lastCol < 2) return { ok: true, dates: {}, sheetName: name };

  const values = sh.getRange(1, 1, last, lastCol).getDisplayValues();
  const blocks = parseOrderSheetBlocks(values);
  const months = [];
  blocks.forEach(b => { if (months.indexOf(b.month) < 0) months.push(b.month); });

  if (!months.length) {
    return {
      ok: false, dates: {}, sheetName: name,
      reason: `${name} に年月と見出しが見つからない。`
        + '「R8年10月」のような年月のセルと「日付」「注文品」の見出しが要る',
    };
  }
  if (months.indexOf(month) < 0) {
    return {
      ok: false, dates: {}, sheetName: name,
      reason: `${name} に ${month} が無い (入っているのは ${months.join(' / ')})`,
    };
  }

  return { ok: true, sheetName: name, dates: collectOrderSheetDinners(values, month) };
}

/**
 * 注文確認票から「夕食がある日」を拾う。
 *  見る先は2つ。両方見て OR で足す。
 *    ① 同じスプレッドシート内の一次転記シート (ORDER_SHEET.LOCAL_SHEET_NAME)
 *    ② ほなみやと共有している注文確認票ファイル
 *       (Googleスプレッドシート形式に変換してIDを登録したとき)
 *  どちらか1つでも読めれば ok にする。
 *
 *  @return {{ok, dates: Object, sources: Array, reason}}
 *    dates = { 'yyyy-MM-dd': ['牛すき+おにぎり', ...] }
 */
function readOrderSheetDinners_(month) {
  const O = CONFIG.PAYROLL.ORDER_SHEET;
  const dates = {};
  const sources = [];
  const reasons = [];
  let anyOk = false;

  function absorb(res) {
    if (!res) return;
    if (res.ok) {
      anyOk = true;
      sources.push(res.sheetName);
      Object.keys(res.dates).forEach(d => {
        if (!dates[d]) dates[d] = [];
        res.dates[d].forEach(x => { if (dates[d].indexOf(x) < 0) dates[d].push(x); });
      });
    } else if (res.reason) {
      reasons.push(res.reason);
    }
  }

  // ① 同じブック内の一次転記シート
  if (O.LOCAL_SHEET_NAME) {
    const sh = SpreadsheetApp.getActive().getSheetByName(O.LOCAL_SHEET_NAME);
    if (sh) {
      try {
        absorb(readOneOrderSheet_(sh, month, '一次転記'));
      } catch (e) {
        reasons.push(`一次転記シートの読み取りに失敗: ${e.message || e}`);
      }
    } else {
      reasons.push(`「${O.LOCAL_SHEET_NAME}」タブが無い`);
    }
  }

  // ② ほなみやと共有しているファイル (変換してIDを登録したときだけ)
  const id = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.ORDER_EXPORT.PROP_TARGET_ID);
  if (id) {
    try {
      const ss = SpreadsheetApp.openById(id);
      const sheets = findOrderSheetsForMonth_(ss, month);
      if (sheets.length) {
        sheets.forEach(sh => absorb(readOneOrderSheet_(sh, month, '共有ファイル')));
      } else {
        reasons.push(`共有ファイルに ${month} のタブが見つからない`
          + ` (タブ名: ${ss.getSheets().map(x => x.getName()).join(' / ')})`);
      }
    } catch (e) {
      reasons.push('共有ファイルを開けない。Googleスプレッドシート形式に'
        + `変換されているか確認 (${e.message || e})`);
    }
  }

  return {
    ok: anyOk, dates: dates, sources: sources,
    sheetName: sources.join(' + '),
    reason: anyOk ? '' : (reasons.join(' / ') || '参照先が設定されていない'),
    notes: reasons,
  };
}

// ── 計算本体 (シートに触らない。テストから直接呼べる) ──────────

/**
 * @param {Array<Object>} board readBoardForPayroll_() の出力
 * @param {Array<Object>} deep  readDeepCleanForPayroll_() の出力
 * @param {string} month 'yyyy-MM'
 */
function computeStaffPay(board, deep, month, optionRows, orderSheet) {
  const P = CONFIG.PAYROLL;
  const order = orderSheet || { ok: false, dates: {}, reason: '' };

  //  LatestOptions の食事サマリを日付ごとにまとめておく。
  //  チェックイン対応は日単位なので部屋は問わない。
  const optMealsByDate = {};
  (optionRows || []).forEach(o => {
    if (!o || !o.meal) return;
    if (String(o.checkin).slice(0, 7) !== month) return;
    if (!optMealsByDate[o.checkin]) optMealsByDate[o.checkin] = [];
    optMealsByDate[o.checkin].push(o);
  });

  // 日付+部屋で引けるようにしておく (直前宿泊者の人数を遡るため)
  const byKey = {};
  board.forEach(r => { byKey[r.date + '_' + r.room] = r; });

  const people = {};
  const warnings = [];

  function person(name) {
    if (!people[name]) {
      people[name] = {
        name:     name,
        setup:    { count: 0, rooms: 0, days: [], amount: 0, gross: 0, deduction: 0 },
        bonus:    { headcount: 0, excess: 0, lines: [] },
        deep:     { days: [], amount: 0 },

        checkin:  { a: 0, b: 0, days: [], amount: 0, halfDays: 0, halfCut: 0 },
        total:    0,
      };
    }
    return people[name];
  }

  const inMonth = r => String(r.date).slice(0, 7) === month;

  // ── 「特別」の日の判定 ──────────────────────────────────
  //  B列(種類)が「特別」の行がその日に何部屋あるかで扱いが変わる。
  //    全部屋が特別 … その日まるごと徹底清掃1件 (15pt = 6,000円)
  //    一部だけ特別 … 布団2個の入替清掃として通常のセットアップに回す
  const specialDays = detectSpecialDays_(board, month);

  // ── 客室セットアップ業務 ────────────────────────────────
  //  まず「1件」の単位をまとめてから金額を出す。
  //  U列(達成率)・V列(やり直した箇所)は行ごとに入るので、
  //  1件に 1F/2F の2行がぶら下がる場合はここでまとめる必要がある。
  const units = {};
  const unitOrder = [];
  board.filter(inMonth).forEach(r => {
    if (!r.cleaner || isIgnoredStaffName_(r.cleaner)) return;
    if (P.SETUP.REQUIRE_KIND && !r.cleanKind) return;

    //  両階が特別の日は下の「特別日」処理に回す。ここでは数えない。
    if (specialDays[r.date] && specialDays[r.date].allSpecial) return;

    const key = (P.SETUP.COUNT_UNIT === 'room')
      ? r.cleaner + '|' + r.date + '|' + r.room
      : r.cleaner + '|' + r.date;
    if (!units[key]) {
      units[key] = { cleaner: r.cleaner, date: r.date, rows: [] };
      unitOrder.push(key);
    }
    //  片階だけ特別の行は「布団2個の入替清掃」として扱う。
    //  人数をみなし値に差し替えることで特別報酬が自動的に0になる。
    if (isSpecialCleanKind_(r.cleanKind)) {
      const futons = String(CONFIG.PAYROLL.SPECIAL_DAY.ONE_FLOOR_FUTONS);
      units[key].rows.push(Object.assign({}, r, {
        guests: futons, asTwoFutons: true,
      }));
    } else {
      units[key].rows.push(r);
    }
  });

  unitOrder.forEach(key => {
    const u = units[key];
    const p = person(u.cleaner);
    const cut = setupShortfall_(u.rows);
    const gross = P.SETUP.UNIT_PRICE;
    const net = Math.max(0, gross - cut.deduction);

    p.setup.count++;
    p.setup.rooms += u.rows.length;
    p.setup.gross += gross;
    p.setup.deduction += (gross - net);
    p.setup.amount += net;
    p.setup.days.push({
      label: u.date + (P.SETUP.COUNT_UNIT === 'room' ? ' ' + u.rows[0].room : ''),
      rooms: u.rows.map(r => r.room).join('+'),
      rate:  cut.rate,
      redo:  cut.redoText,
      redoN: cut.redoN,
      spot:  cut.spotText,
      spotPlain: cut.spotPlain,
      gross: gross,
      net:   net,
      note:  cut.note,
    });
    if (cut.note) {
      warnings.push(`清掃減額: ${u.date} ${u.cleaner} — ${cut.note}`);
    }

    //  特別報酬。
    //  ★その日に掃除した全部屋を合計してから「4人超」を判定する。
    //    1件が日単位 (その日の全客室) なので人数も日単位で見る。
    //  「布団2個の入替清掃として扱う」行 (片階だけ特別) は対象外。
    const bonusRows = u.rows.filter(r => !r.asTwoFutons);
    addSetupBonusForUnit_(p, bonusRows, byKey, warnings);
  });

  // ── 両階が特別の日 → 徹底清掃1件 (15pt = 6,000円) ─────────
  //  特シートに同じ (対応者, 日) の pt 行があるときはそちらを正とし、
  //  ここでは付けない (同じ作業を2回払わないため)。
  const deepKeysFromSheet = {};
  deep.forEach(r => {
    const d = normalizeDoneDate_(r.doneDate, month);
    if (d && r.assignee) deepKeysFromSheet[r.assignee + '|' + d] = true;
  });

  Object.keys(specialDays).forEach(date => {
    const sd = specialDays[date];
    if (!sd.allSpecial) return;

    const cleaners = sd.cleaners;
    if (!cleaners.length) {
      warnings.push(`${date} は全部屋が特別だが清掃担当(A列)が入っていない`);
      return;
    }

    const full = deepCleanAmount_(CONFIG.PAYROLL.SPECIAL_DAY.BOTH_FLOORS_PT);
    const cut  = setupShortfall_(sd.rows);
    const gross = Math.round(full.amount / cleaners.length);
    const net   = Math.max(0, gross - Math.round(cut.deduction * gross / P.SETUP.UNIT_PRICE));

    if (cleaners.length > 1) {
      warnings.push(`${date} は全部屋が特別だが清掃担当が複数 (${cleaners.join(' / ')}) —`
        + ` ${yenP_(full.amount)} を人数で等分した`);
    }

    cleaners.forEach(name => {
      if (CONFIG.PAYROLL.SPECIAL_DAY.PREFER_DEEP_SHEET
          && deepKeysFromSheet[name + '|' + date]) {
        warnings.push(`${date} ${name}: 全部屋が特別だが特シートにも同日の pt 行がある`
          + ` — 特シート側で計算し、清掃ボード由来の ${yenP_(gross)} は付けていない`);
        return;
      }
      const p = person(name);
      p.deep.days.push({
        date: date, pt: CONFIG.PAYROLL.SPECIAL_DAY.BOTH_FLOORS_PT,
        amount: net, note: cut.note,
        spot: cut.spotText, spotPlain: cut.spotPlain,
        tasks: [`清掃ボード: 全部屋が特別 (${sd.rows.map(r => r.room).join('+')})`
          + (gross !== net ? ` / 達成率 ${pctP_(cut.rate)} で ${yenP_(gross)}→${yenP_(net)}` : '')],
      });
      p.deep.amount += net;
    });
  });

  // ── 客室徹底清掃業務 (特シート) ──────────────────────────
  const deepByUnit = {};
  deep.forEach(r => {
    const d = normalizeDoneDate_(r.doneDate, month);
    if (!d) {
      if (r.assignee && r.pt) {
        warnings.push(`特シート: 完了日が読めない行がある (対応者=${r.assignee} / 内容=${r.task})`);
      }
      return;
    }
    if (d.slice(0, 7) !== month) return;
    if (!r.assignee || isIgnoredStaffName_(r.assignee)) {
      warnings.push(`特シート: 完了日 ${d} に対応者が入っていない (内容=${r.task})`);
      return;
    }
    const pt = numOrZero(toHalfWidth(r.pt));
    if (pt <= 0) {
      warnings.push(`特シート: ${d} ${r.assignee} の pt が空か0 (内容=${r.task})`);
      return;
    }
    const k = r.assignee + '|' + d;
    if (!deepByUnit[k]) deepByUnit[k] = { assignee: r.assignee, date: d, pt: 0, tasks: [] };
    deepByUnit[k].pt += pt;
    deepByUnit[k].tasks.push(r.task);
  });

  Object.keys(deepByUnit).forEach(k => {
    const u = deepByUnit[k];
    const calc = deepCleanAmount_(u.pt);
    const p = person(u.assignee);
    p.deep.days.push({ date: u.date, pt: u.pt, amount: calc.amount, note: calc.note, tasks: u.tasks });
    p.deep.amount += calc.amount;
    if (calc.note) warnings.push(`徹底清掃: ${u.date} ${u.assignee} ${u.pt}pt — ${calc.note}`);
  });

  // ── チェックイン対応 (接客) ──────────────────────────────
  //  契約書: 「1件」= 1日あたり1回。同日に複数組の到着があっても1件。
  //  仕出し(夕食)がその日にあれば B (4,800円)、なければ A (2,400円)。
  const nightByDay = {};
  board.filter(inMonth).forEach(r => {
    if (!r.server || isIgnoredStaffName_(r.server)) return;
    if (!isArrivalState_(r.state)) return;
    const k = r.server + '|' + r.date;
    if (!nightByDay[k]) {
      nightByDay[k] = {
        server: r.server, date: r.date, dinner: false, rooms: [],
        dinnerSrc: [], boardMeals: [], optMeals: [], orderMeals: [],
      };
    }
    nightByDay[k].rooms.push(r.room);
    if (r.meal) nightByDay[k].boardMeals.push(`${r.room}: ${r.meal}`);
    if (hasDinner_(r.meal)) {
      nightByDay[k].dinner = true;
      if (nightByDay[k].dinnerSrc.indexOf('清掃ボード') < 0) {
        nightByDay[k].dinnerSrc.push('清掃ボード');
      }
    }
    if (isHalfNight_(r.nightHalf)) nightByDay[k].half = true;
  });

  //  ★3つの表のどれか1つでも夕食があれば仕出しあり (OR)。
  //    ② LatestOptions
  Object.keys(nightByDay).forEach(k => {
    const u = nightByDay[k];
    (optMealsByDate[u.date] || []).forEach(o => {
      u.optMeals.push(`${o.room || '?'} ${o.guestName}: ${o.meal}`);
      if (hasDinner_(o.meal)) {
        u.dinner = true;
        if (u.dinnerSrc.indexOf('LatestOptions') < 0) u.dinnerSrc.push('LatestOptions');
      }
    });
    //    ③ ほなみや注文確認票 (ここに入る品目はすでに夕食だけに絞ってある)
    const od = order.dates[u.date];
    if (od && od.length) {
      u.orderMeals = od.slice();
      u.dinner = true;
      if (u.dinnerSrc.indexOf('注文確認票') < 0) u.dinnerSrc.push('注文確認票');
    }
  });

  Object.keys(nightByDay).forEach(k => {
    const u = nightByDay[k];
    const p = person(u.server);
    //  仕出し(夕食)がどの部屋にも無ければ A (チェックイン対応のみ)。
    const full = u.dinner ? P.CHECKIN.PRICE_B : P.CHECKIN.PRICE_A;
    const half = P.CHECKIN.HALF_ENABLED && u.half;
    const amount = half ? Math.round(full * P.CHECKIN.HALF_RATE) : full;
    if (u.dinner) p.checkin.b++; else p.checkin.a++;
    if (half) {
      p.checkin.halfDays++;
      p.checkin.halfCut += (full - amount);
    }
    p.checkin.amount += amount;
    p.checkin.days.push({
      date: u.date, rooms: u.rooms.join('+'),
      type: u.dinner ? 'B(CI+仕出し)' : 'A(CIのみ)',
      amount: amount, full: full, half: half,
      dinnerSrc:  u.dinnerSrc.join('+'),
      boardMeals: u.boardMeals.join(' | '),
      optMeals:   u.optMeals.join(' | '),
      orderMeals: u.orderMeals.join(' | '),
    });

    //  食事の文字列はあるのに夕食と判定しなかった日は見落としの疑いがある。
    //  金額に関わるので必ず表に出す。
    if (!u.dinner && (u.boardMeals.length || u.optMeals.length)) {
      warnings.push(`仕出し判定: ${u.date} ${u.server} は食事の記載があるが`
        + `夕食と判定しなかった → A(${yenP_(P.CHECKIN.PRICE_A)}) で計算した。`
        + ` 内容: ${u.boardMeals.concat(u.optMeals).join(' | ')}`);
    }
  });

  //  注文確認票を見られなかったときは黙って済ませない。
  //  仕出しの判定がその分ゆるくなる (Aに寄る) ため。
  if (P.CHECKIN.USE_ORDER_SHEET && !order.ok && order.reason) {
    warnings.push(`注文確認票を見られませんでした → ${order.reason}`
      + ' (清掃ボードと LatestOptions だけで判定しています)');
  }

  //  内訳はすべて日付順に並べる (シートの行順や集計順に左右されない)
  const byDate = (a, b) => (a.date || a.label || '') < (b.date || b.label || '') ? -1
    : ((a.date || a.label || '') > (b.date || b.label || '') ? 1 : 0);
  Object.keys(people).forEach(n => {
    people[n].setup.days.sort(byDate);
    people[n].deep.days.sort(byDate);
    people[n].checkin.days.sort(byDate);
  });

  // ── 契約の有無で足切り + 合計 ───────────────────────────
  const list = Object.keys(people).map(n => {
    const p = people[n];
    const c = P.CONTRACTS[n] || null;
    p.contractKnown = !!c;
    p.pay = {
      setup:   (!c || c.setup   !== false) ? p.setup.amount   : 0,
      bonus:   (!c || c.setup   !== false) ? bonusAmount_(p)  : 0,
      deep:    (!c || c.deep    !== false) ? p.deep.amount    : 0,
      checkin: (!c || c.checkin !== false) ? p.checkin.amount : 0,
    };
    p.total = p.pay.setup + p.pay.bonus + p.pay.deep + p.pay.checkin;
    return p;
  }).sort((a, b) => b.total - a.total);

  // ── 契約期間の確認 ─────────────────────────────────────
  const T = P.TERMS;
  const mStart = month + '-01';
  if (mStart < T.SETUP_FROM.slice(0, 7) + '-01' || month > T.SETUP_TO.slice(0, 7)) {
    warnings.push(`${month} はセットアップ契約の有効期間 (${T.SETUP_FROM}〜${T.SETUP_TO}) の外`);
  }
  if (month < T.CHECKIN_FROM.slice(0, 7) || month > T.CHECKIN_TO.slice(0, 7)) {
    warnings.push(`${month} はチェックイン対応契約の有効期間 (${T.CHECKIN_FROM}〜${T.CHECKIN_TO}) の外`);
  }

  // 当月を計算している場合は「見込み」である旨を明示する
  const today = Utilities.formatDate(todayJst(), CONFIG.TZ, 'yyyy-MM-dd');
  const estimate = today.slice(0, 7) <= month;

  return {
    month:    month,
    people:   list,
    excluded: countExcludedWork_(board, month),
    warnings: warnings,
    estimate: estimate,
    today:    today,
    grand:    list.reduce((s, p) => s + p.total, 0),
  };
}

// ── 部品 ────────────────────────────────────────────────────

/** 'yyyy-MM' / '2026-10-01' / '2026/10' / Date を 'yyyy-MM' にする。 */
function normalizePayrollMonth_(ym) {
  if (ym instanceof Date) return Utilities.formatDate(ym, CONFIG.TZ, 'yyyy-MM');
  const s = toHalfWidth(String(ym || '')).trim().replace(/\//g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})/);
  if (!m) throw new Error(`月の指定が読めません: ${ym} ('2026-10' の形式で渡してください)`);
  return m[1] + '-' + ('0' + m[2]).slice(-2);
}

/** 特シートの完了日。'10/5' のような年なし表記も月から補う。 */
function normalizeDoneDate_(v, month) {
  const s = toHalfWidth(String(v || '')).trim().replace(/[.年月]/g, '-').replace(/日/g, '');
  if (!s) return '';
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${('0' + m[2]).slice(-2)}-${('0' + m[3]).slice(-2)}`;
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})$/);
  if (m) {
    const y = String(month || '').slice(0, 4) || String(todayJst().getFullYear());
    return `${y}-${('0' + m[1]).slice(-2)}-${('0' + m[2]).slice(-2)}`;
  }
  const d = toDate(v);
  return d ? fmtDate(d) : '';
}

function isIgnoredStaffName_(name) {
  const s = String(name || '').trim();
  if (!s) return true;
  if (CONFIG.STAFF.IGNORE.indexOf(s) >= 0) return true;
  //  給料が発生しない人 (オーナー本人など)。
  //  作業自体は実在するので、日数はログの末尾に出す。
  return (CONFIG.PAYROLL.NO_PAY_NAMES || []).indexOf(s) >= 0;
}

/** 給料が発生しない人の作業日数を数える (ログで見せるため)。 */
function countExcludedWork_(board, month) {
  const names = CONFIG.PAYROLL.NO_PAY_NAMES || [];
  const out = {};
  if (!names.length) return out;
  board.forEach(r => {
    if (String(r.date).slice(0, 7) !== month) return;
    [['cleaner', '清掃'], ['server', '接客']].forEach(pair => {
      const nm = String(r[pair[0]] || '').trim();
      if (names.indexOf(nm) < 0) return;
      if (!out[nm]) out[nm] = { 清掃: {}, 接客: {} };
      out[nm][pair[1]][r.date] = true;
    });
  });
  Object.keys(out).forEach(nm => {
    out[nm] = {
      cleanDays: Object.keys(out[nm]['清掃']).length,
      nightDays: Object.keys(out[nm]['接客']).length,
    };
  });
  return out;
}

function isSpecialCleanKind_(kind) {
  const s = String(kind || '');
  return CONFIG.PAYROLL.SETUP.SPECIAL_KIND_PATTERNS.some(re => re.test(s));
}

function isArrivalState_(state) {
  const s = String(state || '');
  return CONFIG.PAYROLL.CHECKIN.ARRIVAL_PATTERNS.some(re => re.test(s));
}

/**
 * 食事サマリを品目ごとに切り分ける。
 *  ・「⚠」以降は自由記述の注記なので切り落とす (注文ではない)。
 *  ・「, 」「、」「 / 」で区切る。
 */
function splitMealItems_(meal) {
  const K = CONFIG.PAYROLL.CHECKIN;
  const body = String(meal || '').split(K.NOTE_MARKER)[0];
  return body.split(K.ITEM_SEPARATORS).map(x => x.trim()).filter(x => x);
}

/**
 * 品目1つを 'dinner' / 'breakfast' / 'other' に分類する。
 *  ① CONFIG.MEALS のラベルに当たればその kind を使う
 *     ("(paid) Shabu-Shabu(2人前)" や "Chicken Hot Pot Set(2人用)" も拾える)
 *  ② 朝食の表記 (Ochazuke Breakfast を夕食に取り違えないため先に見る)
 *  ③ 夕食のキーワード ("Shabu(2人用)" のような略称や手書きの日本語)
 */
function classifyMealItem_(item) {
  const s = String(item || '').trim();
  if (!s) return 'other';
  //  ★注文確認票の商品名は全角が混ざる (「ＢＢＱセットおにぎり」など)。
  //    半角化したものも併せて見る。カナは半角のまま残るので
  //    「しゃぶ」「鍋」の判定には影響しない。
  const half = toHalfWidth(s);
  const low  = s.toLowerCase();
  const lowH = half.toLowerCase();

  for (let i = 0; i < CONFIG.MEALS.length; i++) {
    const m = CONFIG.MEALS[i];
    const label = String(m.label).toLowerCase();
    if (low.indexOf(label) >= 0 || lowH.indexOf(label) >= 0) return m.kind;
  }
  const K = CONFIG.PAYROLL.CHECKIN;
  if (K.BREAKFAST_HINTS.some(re => re.test(s) || re.test(half))) return 'breakfast';
  if (K.DINNER_HINTS.some(re => re.test(s) || re.test(half)))    return 'dinner';
  return 'other';
}

/** 食事サマリに夕食(仕出し)が1品でも入っているか。 */
function hasDinner_(meal) {
  return splitMealItems_(meal).some(x => classifyMealItem_(x) === 'dinner');
}

/**
 * 特別報酬を1件 (= その日の清掃1件) 分積む。
 *
 *   次回宿泊者 … その日に入る人の合計 (状態に IN を含む行の泊人を合算)
 *   直前宿泊者 … 同じ部屋の前日の泊人の合計 (その人たちが今朝出ていった)
 *
 *  ★部屋ごとではなく「その日の合計」で 4人超を判定する。
 *    1件が日単位 (その日の全客室) なので人数も日単位で見る。
 *    例: 1F 4名 + 2F 2名 = 6名 → (6-4)×200 = 400円
 *        部屋ごとに見ると 4名も2名も4人超でないため 0円になってしまう。
 */
function addSetupBonusForUnit_(p, rows, byKey, warnings) {
  const B = CONFIG.PAYROLL.BONUS;
  const th = B.THRESHOLD;
  if (!rows.length) return;

  //  部屋ごとに判定する設定のときは、1部屋を1件として扱う
  const groups = B.SUM_ROOMS ? [rows] : rows.map(r => [r]);

  groups.forEach(g => {
    const date = g[0].date;

    // 次回宿泊者 (到着日の行だけ合算)
    let next = 0;
    const nextParts = [];
    g.forEach(r => {
      if (!isArrivalState_(r.state)) return;
      const n = bonusHeadcount_(r);
      next += n;
      nextParts.push(`${r.room}${n}名`);
      if (n === 0 && r.guestName) {
        warnings.push(`特別報酬: ${r.date} ${r.room} は到着日だが人数が空 (${r.guestName}) — 人数未確定`);
      }
    });

    // 直前宿泊者 (同じ部屋の前日を合算)
    let prev = 0;
    const prevParts = [];
    g.forEach(r => {
      const pr = byKey[addDaysStr(r.date, -1) + '_' + r.room];
      const n = pr ? bonusHeadcount_(pr) : 0;
      if (n > 0) { prev += n; prevParts.push(`${r.room}${n}名`); }
    });

    if (next > th) {
      p.bonus.headcount += next * B.NEXT_RATE;
      p.bonus.excess    += (next - th) * B.NEXT_RATE;
      p.bonus.lines.push(`${date} 次回${next}名 (${nextParts.join('+')})`
        + ` → ${yenP_((next - th) * B.NEXT_RATE)}`);
    }
    if (prev > th) {
      p.bonus.headcount += prev * B.PREV_RATE;
      p.bonus.excess    += (prev - th) * B.PREV_RATE;
      p.bonus.lines.push(`${date} 直前${prev}名 (${prevParts.join('+')})`
        + ` → ${yenP_((prev - th) * B.PREV_RATE)}`);
    }
  });
}

/**
 * 「特別」の日を洗い出す。
 *  その日に清掃の行が立っている部屋のうち、何部屋が「特別」かを見る。
 *  全部が特別なら allSpecial = true (= その日まるごと徹底清掃)。
 *
 *  ★判定の母数は CONFIG.CLEANING.ROOMS ではなく
 *    「その日に清掃担当が入っている行」にする。
 *    片方の階が空室で清掃不要な日に、1部屋だけ特別が立っていても
 *    「全部屋が特別」と誤判定しないため。
 *    ただし母数が1部屋しかない日は「両階とも特別」ではないので
 *    allSpecial にしない (= 布団2個扱いに回る)。
 */
function detectSpecialDays_(board, month) {
  const byDate = {};
  board.forEach(r => {
    if (String(r.date).slice(0, 7) !== month) return;
    if (!r.cleaner || isIgnoredStaffName_(r.cleaner)) return;
    if (CONFIG.PAYROLL.SETUP.REQUIRE_KIND && !r.cleanKind) return;
    if (!byDate[r.date]) byDate[r.date] = { rooms: [], special: [] };
    byDate[r.date].rooms.push(r);
    if (isSpecialCleanKind_(r.cleanKind)) byDate[r.date].special.push(r);
  });

  const out = {};
  Object.keys(byDate).forEach(date => {
    const d = byDate[date];
    const allSpecial = d.special.length >= 2 && d.special.length === d.rooms.length;
    const cleaners = [];
    d.special.forEach(r => {
      if (cleaners.indexOf(r.cleaner) < 0) cleaners.push(r.cleaner);
    });
    out[date] = {
      allSpecial: allSpecial,
      rows:       d.special,
      cleaners:   cleaners,
      roomCount:  d.rooms.length,
    };
  });
  return out;
}

/**
 * U列「清掃達成率」を 0〜1 の比率にする。
 *  '90%' / '0.9' / '90' / '９０％' のどれでも読む。
 *  空欄・読めない値は null (= 記入なし。減額しない)。
 *  1 を超える値は 1 に丸める (達成率で増額はしない)。
 */
function parseAchieveRate_(v) {
  const raw = toHalfWidth(String(v || '')).trim().replace(/％/g, '%');
  if (!raw) return null;
  const hasPct = raw.indexOf('%') >= 0;
  const n = Number(raw.replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || raw.replace(/[^0-9.]/g, '') === '') return null;
  //  '%' が付いていれば必ずパーセント。
  //  付いていなければ 1以下は比率 (0.9)、1超はパーセント (90) と読む。
  //  ちょうど 1 はどちらの読みでも 100% になる。
  const ratio = (hasPct || n > 1) ? n / 100 : n;
  if (ratio < 0) return 0;
  return Math.min(1, ratio);
}

/**
 * V列「清掃やり直した箇所」の箇所数を数える。
 *  「、」「,」「/」「・」「;」改行 を区切りとして扱う。
 *  '-' や 'なし' は 0 件。
 */
function countRedoItems_(v) {
  const raw = String(v || '').trim();
  if (!raw) return 0;
  if (/^(?:-|ー|―|なし|無し|none|no)$/i.test(raw)) return 0;
  return raw.split(/[、,\/・;；\n\r]+/).map(x => x.trim()).filter(x => x).length;
}

/**
 * 1件(= まとめた行の集まり)の清掃減額を出す。
 *  達成率 … CONFIG.PAYROLL.SHORTFALL.AGGREGATE で平均か最小かを選ぶ。
 *           記入のある行だけを見る (未記入の行で薄めない)。
 *  やり直した箇所 … REDO_DEDUCTION が 0 なら金額には効かせず内訳に出すだけ。
 */
function setupShortfall_(rows) {
  const S = CONFIG.PAYROLL.SHORTFALL;
  const price = CONFIG.PAYROLL.SETUP.UNIT_PRICE;

  const rates = rows.map(r => parseAchieveRate_(r.cleanRate)).filter(x => x !== null);
  let rate = null;
  if (rates.length) {
    rate = (S.AGGREGATE === 'min')
      ? Math.min.apply(null, rates)
      : rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  const redoTexts = rows.map(r => String(r.cleanRedo || '').trim()).filter(x => x);
  const redoN = rows.reduce((n, r) => n + countRedoItems_(r.cleanRedo), 0);

  //  X列「特別清掃箇所」。やった内容のメモ。★金額には効かせない。
  const spots = rows
    .filter(r => String(r.spotWork || '').trim())
    .map(r => ({ room: r.room, text: String(r.spotWork).trim() }));

  let deduction = 0;
  let note = '';

  if (rate !== null && rate < 1 && S.RATE_MODE !== 'none') {
    const kept = (S.RATE_MODE === 'contract') ? rate * S.CONTRACT_RATIO : rate;
    deduction += price - Math.round(price * kept);
  }

  if (redoN > 0 && S.REDO_DEDUCTION > 0) {
    deduction += redoN * S.REDO_DEDUCTION;
  }

  if (redoN > 0 && rate === null) note = S.REDO_ONLY_NOTE;

  return {
    rate:      rate,
    redoText:  redoTexts.join(' / '),
    redoN:     redoN,
    spots:     spots,
    spotText:  spots.map(x => `${x.room}: ${x.text}`).join(' / '),
    spotPlain: spots.map(x => x.text).join(' / '),
    deduction: Math.min(price, Math.round(deduction)),
    note:      note,
  };
}

/**
 * W列「接客半日？」に印が付いているか。
 *  空欄 / FALSE / '-' / 'なし' は印なし。
 */
function isHalfNight_(v) {
  const raw = toHalfWidth(String(v || '')).trim();
  if (!raw) return false;
  if (/^(?:FALSE|no|n|x|-|ー|―|なし|無し)$/i.test(raw)) return false;
  return CONFIG.PAYROLL.CHECKIN.HALF_TRUE_PATTERNS.some(re => re.test(raw));
}

/** 達成率を幅をそろえた文字列にする ('95%   ' / '100%  ')。 */
function padPct_(rate) {
  const t = pctP_(rate);
  return t + ' '.repeat(Math.max(1, 6 - t.length));
}

function pctP_(rate) {
  if (rate === null || rate === undefined) return '未記入';
  return Math.round(rate * 1000) / 10 + '%';
}

/**
 * 特別報酬の判定に使う人数を1行から採る。
 *  CONFIG.PAYROLL.BONUS.SOURCE で F列(泊人) か C列(べ) を選ぶ。
 */
function bonusHeadcount_(row) {
  if (!row) return 0;
  const v = (CONFIG.PAYROLL.BONUS.SOURCE === 'sets') ? row.setGuests : row.guests;
  return numOrZero(toHalfWidth(v));
}

function bonusAmount_(p) {
  return (CONFIG.PAYROLL.BONUS.BASE === 'excess') ? p.bonus.excess : p.bonus.headcount;
}

/**
 * 徹底清掃の金額。
 *  15pt → 6,000円 / 15pt超は20ptまで比例 (20pt → 8,000円)
 *  15pt未満は 進捗度合い×70% (契約書の未完了条項) として要協議で出す。
 */
function deepCleanAmount_(pt) {
  const D = CONFIG.PAYROLL.DEEP;
  if (pt >= D.BASE_PT) {
    const eff = Math.min(pt, D.MAX_PT);
    const amount = Math.round(D.BASE_PRICE * eff / D.BASE_PT);
    const note = (pt > D.MAX_PT) ? `⚠${D.MAX_PT}pt超過分は増額対象外 (実績${pt}pt)` : '';
    return { amount: amount, note: note };
  }
  const amount = Math.round(D.BASE_PRICE * (pt / D.BASE_PT) * D.SHORT_RATIO);
  return { amount: amount, note: D.SHORT_NOTE };
}

function yenP_(n) {
  return '¥' + Math.round(numOrZero(n)).toLocaleString('en-US');
}

// ── ログ出力 ────────────────────────────────────────────────

function logStaffPay_(res) {
  const P = CONFIG.PAYROLL;
  const L = [];
  L.push('════════════════════════════════════════════');
  L.push(`  ${res.month} 業務委託料`);
  if (res.estimate) {
    L.push(`  ★${res.today} 時点の見込み。未来の予定を含むので確定額ではない。`);
  }
  L.push('════════════════════════════════════════════');

  if (!res.people.length) {
    L.push('対象の担当者が1人も見つかりませんでした。');
    L.push('CleaningBoard の A列(清掃担当) / D列(接客担当) に名前が入っているか確認してください。');
  }

  res.people.forEach(p => {
    L.push('');
    L.push(`── ${p.name} `);

    if (p.setup.count) {
      L.push(`  客室セットアップ  ${p.setup.count}件 `);
      p.setup.days.forEach(d => {
        let line = `       ${d.label}  ${d.rooms}  達成率 ${padPct_(d.rate)}${yenP_(d.net)}`;
        if (d.redoN)     line += `  やり直し${d.redoN}箇所`;
        if (d.spotPlain) line += `  ※特別清掃: ${d.spotPlain}`;
        if (d.note)      line += `  ${d.note}`;
        L.push(line);
      });
    }

    if (p.pay.bonus) {
      L.push(`  特別報酬          ${yenP_(p.pay.bonus)}`);
      p.bonus.lines.forEach(x => L.push(`       ${x}`));
    }

    if (p.deep.days.length) {
      L.push(`  客室徹底清掃      ${p.deep.days.length}件 `);
      p.deep.days.forEach(d => {
        let line = `       ${d.date}  ${d.pt}pt  ${yenP_(d.amount)}`;
        if (d.spotPlain) line += `  ※特別清掃: ${d.spotPlain}`;
        if (d.note)      line += `  ${d.note}`;
        L.push(line);
      });
    }

    if (p.checkin.days.length) {
      L.push(`  チェックイン対応  A ${p.checkin.a}件 / B ${p.checkin.b}件 `);
      p.checkin.days.forEach(d => {
        L.push(`       ${d.date}  ${d.rooms}  ${d.type}  ${yenP_(d.amount)}`
          + (d.half ? '  半日' : ''));
      });
    }

    L.push(`  ── 合計 ${yenP_(p.total)}`);
  });

  L.push('');
  L.push(`総額 ${yenP_(res.grand)}`);

  if (res.warnings.length) {
    L.push('');
    L.push('── 確認が必要なもの ──────────────────────');
    res.warnings.forEach(w => L.push(`  ⚠ ${w}`));
  }

  L.push('');
  L.push('── 計算に使った読み (変えるときは Config.gs の PAYROLL) ──');
  L.push(`  セットアップ1件の単位 : ${P.SETUP.COUNT_UNIT}  (day = 同じ日に1F+2F掃除しても1件)`
    + `  / 1件 ${yenP_(P.SETUP.UNIT_PRICE)}`);
  L.push(`  両階とも「特別」の日   : ${P.SPECIAL_DAY.BOTH_FLOORS_PT}pt 相当`
    + ` = ${yenP_(deepCleanAmount_(P.SPECIAL_DAY.BOTH_FLOORS_PT).amount)} (セットアップは付けない)`);
  L.push(`  片階だけ「特別」の日   : 布団${P.SPECIAL_DAY.ONE_FLOOR_FUTONS}個の入替清掃として扱う`
    + ' (= その日のセットアップ1件に含める / 特別報酬なし)');
  L.push(`  「特」シート           : ${P.DEEP.USE_SHEET ? '読む' : '読まない (発注者指示)'}`);
  L.push('  仕出しの判定           : 清掃ボードR列 / LatestOptions / 注文確認票 の'
    + 'いずれか1つでも夕食があれば B');
  L.push(`  チェックイン対応の単価 : A ${yenP_(P.CHECKIN.PRICE_A)} / B ${yenP_(P.CHECKIN.PRICE_B)}`
    + `  ※${P.CHECKIN.TAX_NOTE}`);
  L.push(`  X列(特別清掃箇所)      : ${P.MEMO.ENABLED ? 'メモとしてログに出すだけ (金額には効かせない)' : '見ない'}`);
  L.push(`  特別報酬「その値」     : ${P.BONUS.BASE}`
    + `  (4人超の分 × 次回${yenP_(P.BONUS.NEXT_RATE)} / 直前${yenP_(P.BONUS.PREV_RATE)})`);
  L.push(`  特別報酬の人数         : ${P.BONUS.SUM_ROOMS ? 'その日の全部屋を合計して判定' : '部屋ごとに判定'}`
    + `  / ${P.BONUS.SOURCE === 'sets' ? 'C列 べ' : 'F列 泊人'} を見る`);
  L.push(`  清掃達成率の効かせ方   : ${P.SHORTFALL.RATE_MODE}`
    + (P.SHORTFALL.RATE_MODE === 'contract' ? ` (×${P.SHORTFALL.CONTRACT_RATIO})` : '')
    + `  (1件 ${yenP_(P.SETUP.UNIT_PRICE)} × 達成率)`);
  L.push(`  複数行のまとめ方       : ${P.SHORTFALL.AGGREGATE}`);
  L.push(`  やり直し1箇所の減額   : ${yenP_(P.SHORTFALL.REDO_DEDUCTION)}`
    + (P.SHORTFALL.REDO_DEDUCTION ? '' : ' (0 = 金額には効かせず件数を出すだけ)'));
  L.push(`  接客半日(W列)の掛け率 : `
    + (P.CHECKIN.HALF_ENABLED ? `${P.CHECKIN.HALF_RATE}` : '見ない'));

  //  給料が発生しない人も作業はしているので、日数だけ残す。
  const ex = res.excluded || {};
  Object.keys(ex).forEach(nm => {
    L.push(`  オーナー対応 (給与なし): 「${nm}」 清掃${ex[nm].cleanDays}日 / 接客${ex[nm].nightDays}日`
      + '  ← 清掃ボード A列(清掃) / D列(接客) に名前が入っている日数');
  });

  Logger.log(L.join('\n'));
  return L.join('\n');
}

// ── 仕出し判定の診断 ────────────────────────────────────────

/**
 * 「接客のほとんどが仕出しなしになっている」を実データで確かめる診断。
 *
 *  指定月の、接客担当(D列)が入っている日ごとに
 *    ・清掃ボードの食事列(R) の中身
 *    ・LatestOptions の同日の食事サマリ
 *    ・それを品目ごとに分解した判定結果 (夕食/朝食/その他)
 *    ・最終的な A / B と、判定の出どころ
 *  を全部出す。書き込みはしない。
 *
 *  末尾に、取りこぼしの疑いがあるものを3種類に分けて出す:
 *    ① 食事の記載があるのに夕食と判定しなかった日
 *       → 表記の対応漏れ。CONFIG.MEALS か DINNER_HINTS を直す
 *    ② LatestOptions に注文があるのに清掃ボードのR列が空の日
 *       → フォームと滞在の突合が失敗している
 *    ③ 接客担当が入っているのに食事の記載がどこにも無い日
 *       → そもそも注文が無い (= 正しくA) か、
 *         WhatsApp等で受けた注文が CleaningOverride に未記入
 */
function diagnoseCheckinPay(ym) {
  const month = normalizePayrollMonth_(ym || Utilities.formatDate(
    new Date(todayJst().getFullYear(), todayJst().getMonth() - 1, 1), CONFIG.TZ, 'yyyy-MM'));

  const board = readBoardForPayroll_();
  const opts  = readOptionsForPayroll_();
  let order;
  try {
    order = readOrderSheetDinners_(month);
  } catch (e) {
    order = { ok: false, dates: {}, reason: String(e.message || e) };
  }

  const inMonth = d => String(d).slice(0, 7) === month;
  const P = CONFIG.PAYROLL;

  // 接客担当が入っている到着日を日ごとにまとめる
  const days = {};
  board.filter(r => inMonth(r.date)).forEach(r => {
    if (!r.server || isIgnoredStaffName_(r.server)) return;
    if (!isArrivalState_(r.state)) return;
    const k = r.date + '|' + r.server;
    if (!days[k]) {
      days[k] = { date: r.date, server: r.server, rows: [], optRows: [] };
    }
    days[k].rows.push(r);
  });

  // 同じ日の LatestOptions を付ける (日単位なので部屋は問わない)
  const optByDate = {};
  opts.filter(o => inMonth(o.checkin)).forEach(o => {
    if (!optByDate[o.checkin]) optByDate[o.checkin] = [];
    optByDate[o.checkin].push(o);
  });
  Object.keys(days).forEach(k => {
    days[k].optRows = optByDate[days[k].date] || [];
  });

  const keys = Object.keys(days).sort();
  const L = [];
  L.push('════════════════════════════════════════════');
  L.push(`  ${month} 仕出し(夕食)判定の診断  ※書き込みなし`);
  L.push('════════════════════════════════════════════');
  L.push(`清掃ボード ${month} の行: ${board.filter(r => inMonth(r.date)).length}`);
  L.push(`LatestOptions ${month} の有効行: ${opts.filter(o => inMonth(o.checkin)).length}`);
  if (order.ok) {
    const od = Object.keys(order.dates).sort();
    L.push(`注文確認票 [${order.sheetName}] の夕食がある日: ${od.length}日`
      + (od.length ? ` (${od.map(d => d.slice(8)).join(', ')})` : ''));
    (order.notes || []).forEach(n => L.push(`  ※ ${n}`));
  } else {
    L.push(`注文確認票: ★読めません — ${order.reason}`);
  }
  L.push(`接客担当が入っている到着日: ${keys.length}`);
  L.push('');

  const missLabel = [];   // ① 食事はあるが夕食と判定しなかった
  const missBoard = [];   // ② LatestOptions にあるがボードR列が空
  const noMeal    = [];   // ③ 食事の記載がどこにも無い
  const missOnlyOrder = []; // ④ 注文確認票にしかない (柏屋側の表に未記入)
  let nA = 0, nB = 0;

  keys.forEach(k => {
    const u = days[k];
    const boardMeals = u.rows.filter(r => r.meal);
    const optMeals   = u.optRows.filter(o => o.meal);

    let dinner = false;
    const srcs = [];
    const lines = [];

    boardMeals.forEach(r => {
      const items = splitMealItems_(r.meal);
      const judged = items.map(it => `${it} →${classifyMealItem_(it)}`);
      if (items.some(it => classifyMealItem_(it) === 'dinner')) {
        dinner = true;
        if (srcs.indexOf('清掃ボード') < 0) srcs.push('清掃ボード');
      }
      lines.push(`      ボード ${r.room}: ${r.meal}`);
      lines.push(`               ${judged.join('  /  ')}`);
    });

    optMeals.forEach(o => {
      const items = splitMealItems_(o.meal);
      const judged = items.map(it => `${it} →${classifyMealItem_(it)}`);
      if (items.some(it => classifyMealItem_(it) === 'dinner')) {
        dinner = true;
        if (srcs.indexOf('LatestOptions') < 0) srcs.push('LatestOptions');
      }
      lines.push(`      LatestOptions ${o.room || '?'} ${o.guestName}: ${o.meal}`);
      lines.push(`               ${judged.join('  /  ')}`);
    });

    const orderMeals = order.dates[u.date] || [];
    if (orderMeals.length) {
      dinner = true;
      if (srcs.indexOf('注文確認票') < 0) srcs.push('注文確認票');
      lines.push(`      注文確認票: ${orderMeals.join(', ')}`);
    }

    const verdict = dinner
      ? `B(CI+仕出し) ${yenP_(P.CHECKIN.PRICE_B)}`
      : `A(CIのみ)    ${yenP_(P.CHECKIN.PRICE_A)}`;
    if (dinner) nB++; else nA++;

    L.push(`${u.date} ${u.server}  部屋=${u.rows.map(r => r.room).join('+')}`
      + `  → ${verdict}${srcs.length ? '  [' + srcs.join('+') + ']' : ''}`);
    if (lines.length) lines.forEach(x => L.push(x));
    else L.push('      食事の記載なし (ボードR列・LatestOptions ともに空)');

    if (!dinner && (boardMeals.length || optMeals.length)) {
      missLabel.push(`${u.date} ${u.server}: `
        + boardMeals.map(r => r.meal).concat(optMeals.map(o => o.meal)).join(' | '));
    }
    if (orderMeals.length && !boardMeals.length && !optMeals.length) {
      missOnlyOrder.push(`${u.date} ${u.server}: ${orderMeals.join(', ')}`);
    }
    if (optMeals.length && !boardMeals.length) {
      missBoard.push(`${u.date} ${u.server}: `
        + optMeals.map(o => `${o.room || '?'} ${o.guestName} → ${o.meal}`).join(' | '));
    }
    if (!boardMeals.length && !optMeals.length && !orderMeals.length) {
      noMeal.push(`${u.date} ${u.server} (${u.rows.map(r => r.room + ':' + (r.guestName || '?')).join(', ')})`);
    }
  });

  L.push('');
  L.push(`集計: A ${nA}件 / B ${nB}件`
    + `  = ${yenP_(nA * P.CHECKIN.PRICE_A + nB * P.CHECKIN.PRICE_B)}`);

  L.push('');
  L.push('── ① 食事の記載があるのに夕食と判定しなかった日 ─────────');
  L.push('   表記の対応漏れ。CONFIG.MEALS か CHECKIN.DINNER_HINTS を直す。');
  if (missLabel.length) missLabel.forEach(x => L.push(`   ⚠ ${x}`));
  else L.push('   なし');

  L.push('');
  L.push('── ② LatestOptions に注文があるのにボードR列が空の日 ──────');
  L.push('   フォームと滞在の突合が失敗している (部屋違い・日付違いなど)。');
  L.push('   ★給料の判定は LatestOptions も見ているので金額は正しく出る。');
  if (missBoard.length) missBoard.forEach(x => L.push(`   ⚠ ${x}`));
  else L.push('   なし');

  L.push('');
  L.push('── ④ 注文確認票にしか無い注文 ─────────────────────────');
  L.push('   WhatsApp等で直接受けた注文。給料の判定はこれも見ているので');
  L.push('   金額は正しく出る。清掃ボードに出したいなら');
  L.push('   CleaningOverride の食事列に書くこと。');
  if (missOnlyOrder.length) missOnlyOrder.forEach(x => L.push(`   ・${x}`));
  else L.push('   なし');

  L.push('');
  L.push('── ③ 食事の記載がどこにも無い日 ───────────────────────');
  L.push('   3つの表のどこにも注文が無い日。正しく A のはず。');
  L.push('   注文確認票が読めていない場合はここが多くなるので、');
  L.push('   冒頭の「注文確認票」の行をまず確認すること。');
  if (noMeal.length) noMeal.forEach(x => L.push(`   ・${x}`));
  else L.push('   なし');

  Logger.log(L.join('\n'));
  return {
    month: month, a: nA, b: nB, orderOk: order.ok,
    missLabel: missLabel, missBoard: missBoard,
    missOnlyOrder: missOnlyOrder, noMeal: noMeal,
  };
}

// ── 特別報酬の診断 ──────────────────────────────────────────

/**
 * 「4人を超えた日の加算が効いているか」を実データで確かめる診断。
 *
 *  清掃担当が入っている日ごとに、部屋単位で
 *    当日(次回宿泊者) … F列 泊人 / C列 べ
 *    前日(直前宿泊者) … 同じ部屋の前日の F列 / C列
 *  を並べ、F列読みと C列読みの両方で加算額を出す。書き込みはしない。
 *
 *  ★加算が ¥0 の場合、それが「不具合」なのか「4人超の日が無かった」
 *    だけなのかを、この一覧で区別できるようにするのが目的。
 */
function diagnoseSetupBonus(ym) {
  const d0 = todayJst();
  const month = normalizePayrollMonth_(ym || Utilities.formatDate(
    new Date(d0.getFullYear(), d0.getMonth() - 1, 1), CONFIG.TZ, 'yyyy-MM'));

  const B = CONFIG.PAYROLL.BONUS;
  const th = B.THRESHOLD;
  const board = readBoardForPayroll_();

  const byKey = {};
  board.forEach(r => { byKey[r.date + '_' + r.room] = r; });

  //  清掃1件 (担当者 × 日) にまとめる。給料計算と同じまとめ方。
  const units = {};
  const order = [];
  board.forEach(r => {
    if (String(r.date).slice(0, 7) !== month) return;
    if (!r.cleaner || isIgnoredStaffName_(r.cleaner)) return;
    if (CONFIG.PAYROLL.SETUP.REQUIRE_KIND && !r.cleanKind) return;
    const k = r.cleaner + '|' + r.date;
    if (!units[k]) { units[k] = { cleaner: r.cleaner, date: r.date, rows: [] }; order.push(k); }
    units[k].rows.push(r);
  });
  order.sort((a, b) => units[a].date < units[b].date ? -1 : (units[a].date > units[b].date ? 1 : 0));

  const L = [];
  L.push('════════════════════════════════════════════');
  L.push(`  ${month} 特別報酬 (4人超の加算) の診断  ※書き込みなし`);
  L.push('════════════════════════════════════════════');
  L.push(`しきい値: ${th}人を「超えた」場合に加算 (ちょうど${th}人は対象外)`);
  L.push(`レート  : 次回 ${yenP_(B.NEXT_RATE)} / 直前 ${yenP_(B.PREV_RATE)}  (その値=${B.BASE})`);
  L.push(`人数の列: ${B.SOURCE === 'sets' ? 'C列 べ(布団の数)' : 'F列 泊人(宿泊人数)'}`);
  L.push(`数え方  : ${B.SUM_ROOMS ? 'その日の全部屋を合計してから判定' : '部屋ごとに判定'}`);
  L.push('');

  let hitG = 0, hitS = 0, sumG = 0, sumS = 0;
  const mismatch = [];

  function amt(n, rate) {
    if (n <= th) return 0;
    return (B.BASE === 'excess') ? (n - th) * rate : n * rate;
  }

  order.forEach(k => {
    const u = units[k];
    const rows = u.rows;

    let nextG = 0, nextS = 0, prevG = 0, prevS = 0;
    const nextParts = [], prevParts = [];

    rows.forEach(r => {
      const g = numOrZero(toHalfWidth(r.guests));
      const sv = numOrZero(toHalfWidth(r.setGuests));
      if (isArrivalState_(r.state)) {
        nextG += g; nextS += sv;
        nextParts.push(`${r.room} 泊人${g || '-'}/べ${sv || '-'}`);
      } else {
        nextParts.push(`${r.room} (到着日でない:${r.state || '空'})`);
      }
      const pr = byKey[addDaysStr(r.date, -1) + '_' + r.room];
      const pg = pr ? numOrZero(toHalfWidth(pr.guests))    : 0;
      const ps = pr ? numOrZero(toHalfWidth(pr.setGuests)) : 0;
      prevG += pg; prevS += ps;
      prevParts.push(`${r.room} 泊人${pg || '-'}/べ${ps || '-'}`);
      if (g !== sv || pg !== ps) {
        mismatch.push(`${r.date} ${r.room}  当日 泊人${g}/べ${sv}  前日 泊人${pg}/べ${ps}`);
      }
    });

    const g = amt(nextG, B.NEXT_RATE) + amt(prevG, B.PREV_RATE);
    const sv = amt(nextS, B.NEXT_RATE) + amt(prevS, B.PREV_RATE);
    sumG += g; sumS += sv;
    if (g > 0) hitG++;
    if (sv > 0) hitS++;

    L.push(`${u.date} ${u.cleaner}  部屋=${rows.map(r => r.room).join('+')}`
      + ((g > 0 || sv > 0) ? '   ★加算あり' : ''));
    L.push(`    当日 合計 泊人${nextG} / べ${nextS}   [${nextParts.join('  ')}]`);
    L.push(`    前日 合計 泊人${prevG} / べ${prevS}   [${prevParts.join('  ')}]`);
    L.push(`    → 泊人読み ${yenP_(g)}   べ読み ${yenP_(sv)}`);
  });

  if (!order.length) L.push('対象の清掃行がありません。');

  L.push('');
  L.push('────────────────────────────────────────────');
  L.push(`${th}人を超えた件数: 泊人読み ${hitG}件 / べ読み ${hitS}件`);
  L.push(`特別報酬の合計  : 泊人読み ${yenP_(sumG)} / べ読み ${yenP_(sumS)}`);
  if (!hitG && !hitS) {
    L.push('');
    L.push(`★どちらの読みでも0件でした。${month} に合計が ${th}人を超える日が`);
    L.push('  無かったということです (ちょうど4人は対象外)。');
  }

  L.push('');
  L.push('── 泊人(F列)と べ(C列) が食い違う行 ──────────────');
  L.push('   どちらで判定するかで金額が変わるのはこの行だけです。');
  if (mismatch.length) mismatch.forEach(x => L.push(`   ⚠ ${x}`));
  else L.push('   なし (どちらで判定しても同額)');

  Logger.log(L.join('\n'));
  return { month: month, guests: sumG, sets: sumS, hitGuests: hitG, hitSets: hitS, mismatch: mismatch };
}

// ── 食事予約表と清掃ボードの突合診断 ────────────────────────

/**
 * 「食事予約表と清掃ボードで内容が違う」を調べる。
 *
 *   diagnoseMealMatch()              … 今日
 *   diagnoseMealMatch('2026-10-04')  … 日付指定
 *
 *  指定日について、4つの情報源を並べて出す。書き込みはしない。
 *    ① 清掃ボード      … その日の 1F / 2F の行 (宿泊者名・泊人・状態・食事)
 *    ② LatestOptions   … 宿泊日がその日の行 (論理削除された行も理由つきで出す)
 *    ③ CleaningOverride… 手書きの追記
 *    ④ LodgifyBookings … チェックインがその日の予約 (アドオン込み)
 *
 *  そのうえで、よくあるズレの原因を名指しで出す:
 *    ・LatestOptions にあるのにボードに出ていない (部屋違い・滞在が無い)
 *    ・ボードに出ているのに LatestOptions にその日の行が無い
 *      (連泊の別日にフォームが出ている / CleaningOverride 由来)
 *    ・同じ宿泊者名が別の日付で LatestOptions に入っている
 *      → フォームの宿泊日の書き間違いはこれで分かる
 */
function diagnoseMealMatch(dateStr) {
  const date = dateStr ? fmtDate(toDate(dateStr)) : fmtDate(todayJst());
  const L = [];
  L.push('════════════════════════════════════════════');
  L.push(`  ${date} 食事予約表 と 清掃ボード の突合  ※書き込みなし`);
  L.push('════════════════════════════════════════════');

  // ① 清掃ボード
  const board = readBoardForPayroll_().filter(r => r.date === date);
  L.push('');
  L.push('── ① 清掃ボード ───────────────────────────');
  if (!board.length) {
    L.push('   その日の行がありません。');
  }
  board.forEach(r => {
    L.push(`   ${r.room}  状態=${r.state || '-'}  泊人=${r.guests || '-'}  宿泊者=${r.guestName || '-'}`);
    L.push(`        食事(R列): ${r.meal || '(空)'}`);
    if (r.note) L.push(`        備考: ${r.note}`);
  });

  // ② LatestOptions
  const opt = readOptionRowsWithDeleted_();
  const sameDay = opt.filter(o => o.checkin === date);
  L.push('');
  L.push('── ② 食事予約表 (LatestOptions) ────────────');
  if (!sameDay.length) L.push('   宿泊日がその日の行はありません。');
  sameDay.forEach(o => {
    L.push(`   ${o.room || '(部屋なし)'}  ${o.guestName || '(氏名なし)'}  人数=${o.guests || '-'}`
      + (o.deleted ? '   ★論理削除' : ''));
    L.push(`        食事: ${o.meal || '(空)'}`);
    if (o.option) L.push(`        オプション: ${o.option}`);
    L.push(`        フォーム送信: ${o.formTs || '-'}`);
  });

  // ③ CleaningOverride
  L.push('');
  L.push('── ③ CleaningOverride (手書き) ─────────────');
  const ovr = readOverrideForDiag_(date);
  if (!ovr.length) L.push('   その日の行はありません。');
  ovr.forEach(o => L.push(`   ${o.room}  人数=${o.guests || '-'}  食事=${o.meal || '(空)'}  メモ=${o.memo || '-'}`));

  // ④ Lodgify
  L.push('');
  L.push('── ④ Lodgify 予約 (チェックインがその日) ────');
  const ldg = readLodgifyForDiag_(date);
  if (!ldg.length) L.push('   その日の予約はありません。');
  ldg.forEach(b => {
    L.push(`   ${b.room}  ${b.guestName}  人数=${b.guests}  ${b.status}`
      + (b.deleted ? '   ★論理削除(キャンセル等)' : ''));
    if (b.addons) L.push(`        予約時オプション: ${b.addons}`);
  });

  // ── 突合 ──────────────────────────────────────
  L.push('');
  L.push('── ズレの原因 ─────────────────────────────');
  const found = [];

  const boardByRoom = {};
  board.forEach(r => { boardByRoom[r.room] = r; });

  // (a) LatestOptions にあるのにボードに出ていない
  sameDay.forEach(o => {
    if (o.deleted || !o.meal) return;
    const b = boardByRoom[o.room];
    if (!b) {
      found.push(`${o.room} ${o.guestName}: 食事予約はあるが、清掃ボードに ${o.room} の行が無い`);
      return;
    }
    if (!b.meal) {
      found.push(`${o.room} ${o.guestName}: 食事予約はあるが、ボードの食事列が空。`
        + `ボード側の状態=${b.state}/宿泊者=${b.guestName || '(未取得)'} — `
        + '滞在と突合できていない (部屋違いか、その日に在室が無い)');
      return;
    }
    if (b.meal.indexOf(o.meal) < 0) {
      found.push(`${o.room} ${o.guestName}: 食事予約とボードの食事が一致しない`);
      found.push(`        予約表: ${o.meal}`);
      found.push(`        ボード: ${b.meal}`);
    }
  });

  // (b) ボードに食事があるのに、その日の LatestOptions が無い
  board.forEach(b => {
    if (!b.meal) return;
    const hit = sameDay.filter(o => !o.deleted && o.room === b.room && o.meal);
    if (hit.length) return;
    found.push(`${b.room}: ボードに食事があるが、宿泊日=${date} の食事予約が無い`);
    found.push(`        ボード: ${b.meal}`);
    found.push('        → 連泊の別の日でフォームが出ている / CleaningOverride 由来 / Lodgifyアドオン由来');
  });

  // (c) 同じ宿泊者名が別の日付で入っていないか (フォームの宿泊日の書き間違い)
  board.forEach(b => {
    const nm = String(b.guestName || '').trim();
    if (!nm || nm === '(氏名未取得)') return;
    const others = opt.filter(o => o.guestName && o.checkin !== date
      && sameGuestName_(o.guestName, nm)
      && Math.abs(daysBetweenDiag_(o.checkin, date)) <= 14);
    others.forEach(o => {
      found.push(`${b.room} ${nm}: 同じ名前が 宿泊日=${o.checkin} ${o.room || '(部屋なし)'} で`
        + `食事予約表に入っている${o.deleted ? ' (論理削除済み)' : ''}`);
      found.push(`        その行の食事: ${o.meal || '(空)'}`);
      found.push('        → フォームの宿泊日か部屋の書き間違いの可能性');
    });
  });

  // (d) 論理削除された行に食事が入っている
  sameDay.forEach(o => {
    if (!o.deleted || !o.meal) return;
    found.push(`${o.room || '(部屋なし)'} ${o.guestName}: 論理削除された行に食事予約が残っている`);
    found.push(`        ${o.meal}`);
    found.push('        → 予約がキャンセル/変更された。ほなみやへの発注取消が要るかもしれない');
  });

  if (found.length) found.forEach(x => L.push(`   ⚠ ${x}`));
  else L.push('   食事予約表と清掃ボードの食事は一致しています。');

  L.push('');
  L.push('── どちらが正か ───────────────────────────');
  L.push('   食事予約表(LatestOptions)が正。清掃ボードの食事列(R)は');
  L.push('   そこから (宿泊日, 部屋) で突合して転記しているだけ。');
  L.push('   ボードに出ていない = 突合に失敗している、という意味。');
  L.push('   手で直すときは CleaningOverride の食事列に書くこと。');
  L.push('   ★ボードのR列に直接書いても毎時バッチで消えます。');

  Logger.log(L.join('\n'));
  return { date: date, board: board, options: sameDay, issues: found };
}

/** LatestOptions を論理削除された行も含めて読む (診断用)。 */
function readOptionRowsWithDeleted_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.LATEST_OPT);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const C = CONFIG.COL_OPT;
  const rows = sh.getRange(2, 1, last - 1, C.FORM_JSON).getValues();
  const out = [];
  rows.forEach(r => {
    const d = fmtDate(r[C.CHECKIN - 1]);
    if (!d) return;
    const ts = toDate(r[C.FORM_TS - 1]);
    out.push({
      checkin:   d,
      room:      String(r[C.ROOM - 1]         || '').trim(),
      guestName: String(r[C.GUEST_NAME - 1]   || '').trim(),
      guests:    String(r[C.GUESTS - 1]       || '').trim(),
      meal:      String(r[C.MEAL_SUMMARY - 1] || '').trim(),
      option:    String(r[C.OPT_SUMMARY - 1]  || '').trim(),
      deleted:   r[C.DELETED_FLAG - 1] === '削除',
      formTs:    (ts && !isNaN(ts.getTime())) ? fmtDateTime(ts) : '',
    });
  });
  return out;
}

/** CleaningOverride の指定日の行 (診断用)。 */
function readOverrideForDiag_(date) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.CLEAN_OVERRIDE);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const C = CONFIG.COL_OVR;
  const rows = sh.getRange(2, 1, last - 1, C.MEAL).getValues();
  const out = [];
  rows.forEach(r => {
    if (fmtDate(r[C.CHECKIN - 1]) !== date) return;
    out.push({
      room:   String(r[C.ROOM - 1]   || '').trim(),
      guests: String(r[C.GUESTS - 1] || '').trim(),
      memo:   String(r[C.MEMO - 1]   || '').trim(),
      meal:   String(r[C.MEAL - 1]   || '').trim(),
    });
  });
  return out;
}

/** LodgifyBookings の指定日チェックインの行 (診断用)。 */
function readLodgifyForDiag_(date) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.LODGIFY);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const C = CONFIG.COL_LDG;
  const rows = sh.getRange(2, 1, last - 1, CONFIG.LDG_WIDTH).getValues();
  const out = [];
  rows.forEach(r => {
    if (fmtDate(r[C.CHECKIN - 1]) !== date) return;
    out.push({
      room:      String(r[C.ROOM - 1]       || '').trim(),
      guestName: String(r[C.GUEST_NAME - 1] || '').trim(),
      guests:    String(r[C.GUESTS - 1]     || '').trim(),
      status:    String(r[C.STATUS - 1]     || '').trim(),
      deleted:   r[C.DELETED_FLAG - 1] === '削除',
      addons:    String(r[C.ADDONS - 1]     || '').trim(),
    });
  });
  return out;
}

/** 氏名のゆるい一致 (大小・空白・全半角を無視)。 */
function sameGuestName_(a, b) {
  const norm = x => toHalfWidth(String(x || '')).toLowerCase().replace(/\s+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/** 'yyyy-MM-dd' 同士の日数差。 */
function daysBetweenDiag_(a, b) {
  const da = toDate(a), db = toDate(b);
  if (!da || !db) return 999;
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

// ── 注文確認票への転記漏れの診断 ──────────────────────────────

/**
 * 指定月の注文表を、読める場所から全部集める。
 *  ① 同じブック内の一次転記タブ (ORDER_SHEET.LOCAL_SHEET_NAME)
 *  ② 共有ファイル「柏屋注文確認票」の同じ月のタブ
 *  どちらか片方でも読めればよい。一次転記タブを消しても②で動く。
 *  @return {{sources: Array<{label, values}>, notes: Array<string>}}
 */
function collectOrderSheetSources_(month) {
  const O = CONFIG.PAYROLL.ORDER_SHEET;
  const sources = [], notes = [];

  // ① 一次転記タブ
  if (O.LOCAL_SHEET_NAME) {
    const sh = SpreadsheetApp.getActive().getSheetByName(O.LOCAL_SHEET_NAME);
    if (sh && sh.getLastRow() > 1) {
      const v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
      const has = parseOrderSheetBlocks(v).some(b => b.month === month);
      if (has) sources.push({ label: `一次転記「${sh.getName()}」`, values: v });
      else notes.push(`一次転記タブに ${month} のブロックが無い`);
    } else {
      notes.push(`「${O.LOCAL_SHEET_NAME}」タブが無い`);
    }
  }

  // ② 共有ファイル
  const id = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.ORDER_EXPORT.PROP_TARGET_ID);
  if (id) {
    try {
      const ss = SpreadsheetApp.openById(id);
      const sheets = findOrderSheetsForMonth_(ss, month);
      if (!sheets.length) notes.push(`共有ファイルに ${month} のタブが無い`);
      sheets.forEach(sh => {
        if (sh.getLastRow() < 2) return;
        sources.push({
          label: `共有ファイル「${sh.getName()}」`,
          values: sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues(),
        });
      });
    } catch (e) {
      notes.push(`共有ファイルを開けない (${e.message || e})`);
    }
  } else {
    notes.push('共有ファイルのIDが未設定');
  }

  return { sources: sources, notes: notes };
}

/**
 * 注文確認票と食事予約表を突き合わせる。シートに触らないのでテストできる。
 *
 *  ★突合の判断はここ1か所だけに置く。
 *    ログ(diagnoseOrderSheetMissing)と注記(annotateOrderSheet)が
 *    別々に判定すると、画面とシートで違うことを言い出す。
 *
 *  @param {string} month      'yyyy-MM'
 *  @param {Array}  entries    注文確認票の行 (重複除去済み)
 *  @param {Array}  allOptRows 食事予約表の行 (論理削除も含む / 当月分)
 *  @param {string} today      'yyyy-MM-dd'
 *  @return {Object}
 */
function buildOrderSheetAudit(month, entries, allOptRows, today) {
  const sheetByKey = {};
  entries.forEach(e => {
    const k = `${e.date}|${e.floor}`;
    if (!sheetByKey[k]) sheetByKey[k] = [];
    sheetByKey[k].push(e);
  });

  const all  = allOptRows;
  const live = all.filter(o => !o.deleted && o.meal);

  //  ★予約表は論理削除・論理更新。再提出で差し替わった古い行が残る。
  //    同じ (日付, 部屋) に生きている行があれば「差し替え済み」であって
  //    キャンセルではない。ここを分けないと誤検知だらけになる。
  const liveKey = {};
  all.filter(o => !o.deleted).forEach(o => { liveKey[`${o.checkin}|${o.room}`] = true; });

  const optByKey = {};
  live.forEach(o => {
    const k = `${o.checkin}|${o.room}`;
    if (!optByKey[k]) optByKey[k] = [];
    optByKey[k].push(o);
  });

  //  ── 名前で引けるようにしておく (階違いを見つけるため) ──
  const sheetNameIdx = {};
  entries.forEach(e => {
    if (!e.name) return;
    const k = `${e.date}|${normName_(e.name)}`;
    if (!sheetNameIdx[k]) sheetNameIdx[k] = [];
    sheetNameIdx[k].push(e);
  });

  const missing = [], floorMismatch = [], qtyMismatch = [], matched = [], extra = [];
  const usedSheetKeys = {};

  Object.keys(optByKey).sort().forEach(k => {
    const parts = k.split('|');
    const date = parts[0], room = parts[1];
    const rows = optByKey[k];
    const nm = rows.map(o => o.guestName).filter(x => x)[0] || '(氏名なし)';

    //  予約表側の人数
    const optP = { counts: {}, unknown: [] };
    rows.forEach(o => {
      const p = summaryToPortions(o.meal);
      Object.keys(p.counts).forEach(lb => {
        optP.counts[lb] = (optP.counts[lb] || 0) + p.counts[lb];
      });
      p.unknown.forEach(u => optP.unknown.push(u));
    });

    //  確認票側。同じ階 → 無ければ同じ日の同じ名前 (階違い)
    let sheetRows = sheetByKey[k], sheetKey = k, noteFloor = '', sheetFloor = '';
    if (!sheetRows) {
      const hit = sheetNameIdx[`${date}|${normName_(nm)}`];
      if (hit && hit.length) {
        sheetRows = hit;
        sheetFloor = hit[0].floor;
        sheetKey = `${date}|${sheetFloor}`;
        noteFloor = `予約表=${room} / 確認票=${sheetFloor}`;
      }
    }

    if (!sheetRows) {
      missing.push({ date: date, room: room, name: nm, opt: optP });
      return;
    }
    usedSheetKeys[sheetKey] = true;

    const shP = entriesToPortions(sheetRows);
    const diff = comparePortions(optP.counts, shP.counts);
    const rec = { date: date, room: room, name: nm, opt: optP, sheet: shP,
                  rows: sheetRows, diff: diff,
                  noteFloor: noteFloor, sheetFloor: sheetFloor };
    if (noteFloor) floorMismatch.push(rec);
    else if (diff.length || optP.unknown.length || shP.unknown.length) qtyMismatch.push(rec);
    else matched.push(rec);
  });

  Object.keys(sheetByKey).sort().forEach(k => {
    if (usedSheetKeys[k] || optByKey[k]) return;
    extra.push({ key: k, rows: sheetByKey[k] });
  });

  //  ── 予約が消えた分 ──────────────────────────────────
  //  ★同じ (日付, 部屋) に生きている行がある論理削除は「再提出による
  //    差し替え」なので出さない。
  //  ★★さらに、過ぎた日は出し方を分ける。
  //    markCancelledByDisappearance() は、予約が LatestReservations から
  //    消えると食事予約表に「削除」を立てる。過去の宿泊は iCal から
  //    落ちるので、終わった予約はいずれ必ず削除扱いになる。
  //    つまり過去日の「削除」はキャンセルではなく、ただ終わっただけ。
  //    取消連絡が要るのは「これから提供する日」だけ。
  const deadRows = all.filter(o => o.deleted && o.meal && !liveKey[`${o.checkin}|${o.room}`]);
  const replaced = all.filter(o => o.deleted && o.meal &&  liveKey[`${o.checkin}|${o.room}`]);

  //  同じ内容が二重に残っていることがあるのでまとめる
  const deadSeen = {};
  const dead = [];
  deadRows.forEach(o => {
    const k = [o.checkin, o.room, normName_(o.guestName), o.meal].join('|');
    if (deadSeen[k]) return;
    deadSeen[k] = true;
    dead.push(o);
  });
  const cancelled = dead.filter(o => o.checkin >= today);   // これから
  const finished  = dead.filter(o => o.checkin <  today);   // 済んだ

  //  ⑤に出た (日付,部屋) は④から除く。同じ話を2回出さない。
  const deadKey = {};
  dead.forEach(o => { deadKey[`${o.checkin}|${o.room}`] = true; });
  const extraLive = extra.filter(x => !deadKey[x.key]);

  return {
    month: month,
    entries: entries,
    sheetByKey: sheetByKey,
    liveCount: live.length,
    deletedCount: all.length - all.filter(o => !o.deleted).length,
    missing: missing,
    floorMismatch: floorMismatch,
    qtyMismatch: qtyMismatch,
    matched: matched,
    extra: extra,
    extraLive: extraLive,
    cancelled: cancelled,
    finished: finished,
    replaced: replaced,
  };
}

/**
 * 「食事予約表にあるのに、ほなみや注文確認票に書かれていない注文」を探す。
 *
 *   diagnoseOrderSheetMissing()            … 当月
 *   diagnoseOrderSheetMissing('2026-10')   … 月を指定
 *
 *  食事予約表(LatestOptions) と 注文確認票 を (日付, 階) で突き合わせる。
 *  書き込みはしない。
 *
 *  ★品目名は英語(Wagyu Sukiyaki)と日本語(牛すき+おにぎり)で表記が違い、
 *    数量も「人前」と「セット」で単位が違う。機械的に1対1で照合すると
 *    誤検知だらけになるので、
 *      ① 片方にしか無い (日付, 階) を機械判定で出す  ← ここが本命
 *      ② 両方にある分は中身を並べて出す (人の目で見る)
 *    という形にしてある。
 */
function diagnoseOrderSheetMissing(ym) {
  const month = normalizePayrollMonth_(ym
    || Utilities.formatDate(todayJst(), CONFIG.TZ, 'yyyy-MM'));

  const L = [];
  L.push('════════════════════════════════════════════');
  L.push(`  ${month} 注文確認票への転記漏れ  ※書き込みなし`);
  L.push('════════════════════════════════════════════');
  L.push('単位: 食事予約表=人数 / 注文確認票=セット'
    + ` (夕食1セット=${personsPerSet_('dinner')}名 / 朝食1セット=${personsPerSet_('breakfast')}名)`);
  L.push('      比較はすべて人数に揃えて行っています。');

  const r = readOrderSheetAudit_(month);
  r.srcLabels.forEach(x => L.push(x));
  if (!r.ok) {
    L.push(`★${month} の注文表をどこからも読めません。`);
    L.push('  一次転記タブか、共有ファイルの月タブのどちらかが要ります。');
    Logger.log(L.join('\n'));
    return null;
  }
  const a = r.audit;

  L.push(`食事予約表 ${month}: 有効 ${a.liveCount}件 / 論理削除 ${a.deletedCount}件`);
  L.push(`注文確認票 ${month}: ${a.entries.length}行`);

  // ── ① 転記漏れ ─────────────────────────────────────────
  L.push('');
  L.push('── ① 食事予約表にあるのに注文確認票に無い (転記漏れ) ──');
  if (!a.missing.length) L.push('   なし');
  a.missing.forEach(m => {
    L.push(`   ⚠ ${m.date} ${m.room} ${m.name}`);
    Object.keys(m.opt.counts).sort().forEach(lb => {
      L.push(`        ${lb}  →  ${portionsToSetText_(lb, m.opt.counts[lb])}`);
    });
    m.opt.unknown.forEach(u => L.push(`        ⚠人数が読めない: ${u}`));
  });

  // ── ② 階が食い違っている ───────────────────────────────
  L.push('');
  L.push('── ② 同じ人が違う階に書かれている ────────────────────');
  if (!a.floorMismatch.length) L.push('   なし');
  a.floorMismatch.forEach(m => {
    L.push(`   ⚠ ${m.date} ${m.name}   ${m.noteFloor}`);
    logPortionDiff_(L, m);
  });

  // ── ③ 数量が合わない ───────────────────────────────────
  L.push('');
  L.push('── ③ 数量が合わない ──────────────────────────────');
  if (!a.qtyMismatch.length) L.push('   なし');
  a.qtyMismatch.forEach(m => {
    L.push(`   ⚠ ${m.date} ${m.room} ${m.name}`);
    logPortionDiff_(L, m);
  });

  // ── ④ 確認票にあるが予約表に無い ──────────────────────
  L.push('');
  L.push('── ④ 注文確認票にあるのに食事予約表に無い ────────────');
  L.push('   WhatsApp等で直接受けた注文。CleaningOverride に書けば');
  L.push('   清掃ボードにも出て、給料の仕出し判定にも乗ります。');
  if (!a.extraLive.length) L.push('   なし');
  a.extraLive.forEach(x => {
    const parts = x.key.split('|');
    const nm = x.rows.map(e => e.name).filter(v => v)[0] || '(氏名なし)';
    L.push(`   ・${parts[0]} ${parts[1]} ${nm}: `
      + x.rows.map(e => `${e.item} x${e.qty}`).join(', '));
  });
  if (a.extra.length !== a.extraLive.length) {
    L.push(`   (⑤に出ている ${a.extra.length - a.extraLive.length}件は除いています)`);
  }

  L.push('');
  L.push('── ⑤ 予約が消えたのに食事注文が残っている (これからの日) ──');
  L.push('   確認票に書いてあれば、ほなみやへ取消の連絡が要ります。');
  if (!a.cancelled.length) L.push('   なし');
  a.cancelled.forEach(o => {
    const k = `${o.checkin}|${o.room}`;
    L.push(`   ${a.sheetByKey[k] ? '⚠ 確認票に残っている' : '・確認票には無い'}`
      + `  ${o.checkin} ${o.room} ${o.guestName}: ${o.meal}`);
  });

  L.push('');
  L.push('── (参考) 済んだ日の削除 ─────────────────────────');
  L.push('   過去の宿泊は iCal から落ちるため、終わった予約は必ず');
  L.push('   「削除」になります。キャンセルではありません。対応不要です。');
  L.push(`   ${a.finished.length}件`);
  a.finished.forEach(o => L.push(`   ・${o.checkin} ${o.room} ${o.guestName}`));
  L.push(`   (再提出で差し替わった古い行 ${a.replaced.length}件は別途除いています)`);

  L.push('');
  L.push(`集計: 転記漏れ ${a.missing.length} / 階違い ${a.floorMismatch.length}`
    + ` / 数量違い ${a.qtyMismatch.length} / 一致 ${a.matched.length}`
    + ` / 確認票のみ ${a.extraLive.length} / 要取消 ${a.cancelled.length}`
    + ` / 済んだ削除 ${a.finished.length}`);

  Logger.log(L.join('\n'));
  return a;
}

/**
 * 突合に必要なものをシートから読んで buildOrderSheetAudit に渡す。
 *  シートを読むのはここだけ。判断は buildOrderSheetAudit 側。
 *  @return {{ok, audit, srcLabels: Array<string>}}
 */
function readOrderSheetAudit_(month) {
  const srcLabels = [];
  const src = collectOrderSheetSources_(month);
  srcLabels.push(`注文表の読み元: ${src.sources.length
    ? src.sources.map(x => x.label).join(' + ') : '(読めません)'}`);
  src.notes.forEach(n => srcLabels.push(`   ※ ${n}`));
  if (!src.sources.length) return { ok: false, audit: null, srcLabels: srcLabels };

  //  複数の読み元に同じ行があると二重に数えるので、
  //  (日付, 階, 品目, 数, 名前) でそろえて1つにする。
  const seen = {};
  const entries = [];
  src.sources.forEach(sObj => {
    readOrderSheetEntries(sObj.values, month).forEach(e => {
      const k = [e.date, e.floor, e.item, e.qty, normName_(e.name)].join('|');
      if (seen[k]) return;
      seen[k] = true;
      entries.push(e);
    });
  });
  entries.sort((a, b) => (a.date + a.floor) < (b.date + b.floor) ? -1 : 1);

  const all = readOptionRowsWithDeleted_().filter(o => o.checkin.slice(0, 7) === month);
  const audit = buildOrderSheetAudit(month, entries, all, fmtDate(todayJst()));
  return { ok: true, audit: audit, srcLabels: srcLabels };
}

/** 両側の人数を並べて差を出す (ログ用)。 */
function logPortionDiff_(L, m) {
  const labels = [];
  Object.keys(m.opt.counts).forEach(k => { if (labels.indexOf(k) < 0) labels.push(k); });
  Object.keys(m.sheet.counts).forEach(k => { if (labels.indexOf(k) < 0) labels.push(k); });
  labels.sort().forEach(lb => {
    const a = m.opt.counts[lb] || 0;
    const b = m.sheet.counts[lb] || 0;
    const mark = (a === b) ? '✓' : (b < a ? `⚠${a - b}人前 不足` : `⚠${b - a}人前 余分`);
    L.push(`        ${lb}   予約表 ${a}人前  /  確認票 ${b}人前   ${mark}`);
  });
  m.opt.unknown.forEach(u => L.push(`        ⚠予約表の人数が読めない: ${u}`));
  m.sheet.unknown.forEach(u => L.push(`        ⚠確認票の品目が読めない: ${u}`));
}

/** 氏名を突合用にそろえる。 */
function normName_(v) {
  return toHalfWidth(String(v || '')).toLowerCase().replace(/[\s,、]+/g, '');
}

// ── 単位をそろえる (人数 ⇔ セット) ──────────────────────────
//  食事予約表 … 人数表記 (2人前 / 4人前)
//  注文確認票 … セット表記 (夕食1セット=2名 / 朝食1セット=1名)
//  突合は必ず「人数」に揃えてから行う。

/** 1品目から人数を拾う。数字が無ければ null (人数不明)。 */
function parsePortionCount_(item) {
  const s = toHalfWidth(String(item || ''));
  const pats = CONFIG.PAYROLL.ORDER_SHEET.PORTION_PATTERNS;
  for (let i = 0; i < pats.length; i++) {
    const m = s.match(pats[i]);
    if (m) {
      const n = Number(m[1]);
      if (isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * 食事予約表の食事サマリを「ラベル → 人数」にする。
 *  @return {{counts: Object, unknown: Array<string>}}
 *    counts  = { 'Chicken Hot Pot': 3, 'Ochazuke Breakfast': 2 }
 *    unknown = 人数が読めなかった品目の原文
 */
function summaryToPortions(summary) {
  const counts = {}, unknown = [];
  splitMealItems_(summary).forEach(item => {
    const kind = classifyMealItem_(item);
    if (kind === 'other') return;
    const label = mealLabelOf_(item);
    //  ★食事だと分かっているのにラベルが決まらない品目を黙って捨てない。
    //    捨てると「予約表には無い」と誤判定して発注漏れになる。
    if (!label) { unknown.push(`${item} (品目名が対応表に無い)`); return; }
    const n = parsePortionCount_(item);
    if (n === null) { unknown.push(item); return; }
    counts[label] = (counts[label] || 0) + n;
  });
  return { counts: counts, unknown: unknown };
}

/** 品目からラベルを決める (英語の食事サマリ用)。 */
function mealLabelOf_(item) {
  const s = String(item || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  const half = toHalfWidth(s).toLowerCase();
  for (let i = 0; i < CONFIG.MEALS.length; i++) {
    const m = CONFIG.MEALS[i];
    const lb = String(m.label).toLowerCase();
    if (low.indexOf(lb) >= 0 || half.indexOf(lb) >= 0) return m.label;
  }
  //  旧フォームの略称など。ラベルに当たらなければ日本語の対応表も見る
  return orderItemLabelOf_(s).label || '';
}

/** 注文確認票の日本語商品名 → {label, kind}。当たらなければ空。 */
function orderItemLabelOf_(item) {
  const s = toHalfWidth(String(item || '').trim());
  const A = CONFIG.PAYROLL.ORDER_SHEET.ITEM_ALIASES;
  for (let i = 0; i < A.length; i++) {
    if (A[i].test.test(s)) return { label: A[i].label, kind: A[i].kind };
  }
  //  日本語で当たらない場合、英語ラベルで当ててみる (混在対策)
  const low = s.toLowerCase();
  for (let i = 0; i < CONFIG.MEALS.length; i++) {
    const m = CONFIG.MEALS[i];
    if (low.indexOf(String(m.label).toLowerCase()) >= 0) {
      return { label: m.label, kind: m.kind };
    }
  }
  return { label: '', kind: '' };
}

/** 1セットが何名分か。 */
function personsPerSet_(kind) {
  const P = CONFIG.PAYROLL.ORDER_SHEET.PERSONS_PER_SET;
  return P[kind] || P.other || 1;
}

/**
 * 注文確認票の行 (セット表記) を「ラベル → 人数」にする。
 *  夕食 1セット → 2名 / 朝食 1セット → 1名
 */
function entriesToPortions(entries) {
  const counts = {}, unknown = [];
  (entries || []).forEach(e => {
    const hit = orderItemLabelOf_(e.item);
    if (!hit.label) { unknown.push(e.item); return; }
    const sets = Number(toHalfWidth(String(e.qty || '')).replace(/[^0-9.]/g, ''));
    if (!isFinite(sets) || sets <= 0) { unknown.push(`${e.item} (数が読めない)`); return; }
    counts[hit.label] = (counts[hit.label] || 0) + sets * personsPerSet_(hit.kind);
  });
  return { counts: counts, unknown: unknown };
}

/** 人数をセット数の表記に戻す (表示用)。 */
function portionsToSetText_(label, persons) {
  const kind = (orderItemLabelOf_(label).kind) || 'dinner';
  const per = personsPerSet_(kind);
  const sets = persons / per;
  return `${persons}人前 (${Math.round(sets * 100) / 100}セット)`;
}

/**
 * 両側の「ラベル → 人数」を比べる。
 * @return {Array<{label, opt, sheet, diff}>} 差があるものだけ
 */
function comparePortions(optCounts, sheetCounts) {
  const labels = [];
  Object.keys(optCounts || {}).forEach(k => { if (labels.indexOf(k) < 0) labels.push(k); });
  Object.keys(sheetCounts || {}).forEach(k => { if (labels.indexOf(k) < 0) labels.push(k); });

  const out = [];
  labels.sort().forEach(label => {
    const a = (optCounts || {})[label] || 0;
    const b = (sheetCounts || {})[label] || 0;
    if (a === b) return;
    out.push({ label: label, opt: a, sheet: b, diff: b - a });
  });
  return out;
}

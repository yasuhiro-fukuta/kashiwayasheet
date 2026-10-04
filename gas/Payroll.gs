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
  const res   = computeStaffPay(board, deep, month, opts);
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
  const width = Math.min(Math.max(sh.getLastColumn(), C.UPDATED_AT), C.NIGHT_HALF);
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

// ── 計算本体 (シートに触らない。テストから直接呼べる) ──────────

/**
 * @param {Array<Object>} board readBoardForPayroll_() の出力
 * @param {Array<Object>} deep  readDeepCleanForPayroll_() の出力
 * @param {string} month 'yyyy-MM'
 */
function computeStaffPay(board, deep, month, optionRows) {
  const P = CONFIG.PAYROLL;

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
      gross: gross,
      net:   net,
      note:  cut.note,
    });
    if (cut.note) {
      warnings.push(`清掃減額: ${u.date} ${u.cleaner} — ${cut.note}`);
    }

    // 特別報酬。人数は部屋ごとに違うので既定では部屋単位で積む。
    //  「布団2個の入替清掃として扱う」行は特別報酬を付けない。
    const bonusRows = (P.BONUS.PER_ROOM ? u.rows : u.rows.slice(0, 1))
      .filter(r => !r.asTwoFutons);
    bonusRows.forEach(r => addSetupBonus_(p, r, byKey, warnings));
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
        dinnerSrc: [], boardMeals: [], optMeals: [],
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

  //  清掃ボードの食事列で拾えなかった分を LatestOptions から補う。
  Object.keys(nightByDay).forEach(k => {
    const u = nightByDay[k];
    (optMealsByDate[u.date] || []).forEach(o => {
      u.optMeals.push(`${o.room || '?'} ${o.guestName}: ${o.meal}`);
      if (hasDinner_(o.meal)) {
        u.dinner = true;
        if (u.dinnerSrc.indexOf('LatestOptions') < 0) u.dinnerSrc.push('LatestOptions');
      }
    });
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
    });

    //  食事の文字列はあるのに夕食と判定しなかった日は見落としの疑いがある。
    //  金額に関わるので必ず表に出す。
    if (!u.dinner && (u.boardMeals.length || u.optMeals.length)) {
      warnings.push(`仕出し判定: ${u.date} ${u.server} は食事の記載があるが`
        + `夕食と判定しなかった → A(${yenP_(P.CHECKIN.PRICE_A)}) で計算した。`
        + ` 内容: ${u.boardMeals.concat(u.optMeals).join(' | ')}`);
    }
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
  return CONFIG.STAFF.IGNORE.indexOf(s) >= 0;
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
 * 特別報酬を1行分積む。
 *   次回宿泊者 … その日その部屋に入る人の人数 (状態に IN を含む行の泊人)
 *   直前宿泊者 … 同じ部屋の前日の泊人 (その人が今朝出ていったので)
 */
function addSetupBonus_(p, r, byKey, warnings) {
  const B = CONFIG.PAYROLL.BONUS;
  const th = B.THRESHOLD;

  // 次回宿泊者
  if (isArrivalState_(r.state)) {
    const n = numOrZero(toHalfWidth(r.guests));
    if (n > th) {
      p.bonus.headcount += n * B.NEXT_RATE;
      p.bonus.excess    += (n - th) * B.NEXT_RATE;
      p.bonus.lines.push(
        `${r.date} ${r.room} 次回${n}名 → 人数読み ${yenP_(n * B.NEXT_RATE)} / 超過読み ${yenP_((n - th) * B.NEXT_RATE)}`);
    } else if (n === 0 && r.guestName) {
      warnings.push(`特別報酬: ${r.date} ${r.room} は到着日だが泊人が空 (${r.guestName}) — 人数未確定`);
    }
  }

  // 直前宿泊者 = 同じ部屋の前日の在室人数
  const prevDate = addDaysStr(r.date, -1);
  const prev = byKey[prevDate + '_' + r.room];
  if (prev) {
    const pn = numOrZero(toHalfWidth(prev.guests));
    if (pn > th) {
      p.bonus.headcount += pn * B.PREV_RATE;
      p.bonus.excess    += (pn - th) * B.PREV_RATE;
      p.bonus.lines.push(
        `${r.date} ${r.room} 直前${pn}名 → 人数読み ${yenP_(pn * B.PREV_RATE)} / 超過読み ${yenP_((pn - th) * B.PREV_RATE)}`);
    }
  }
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

function pctP_(rate) {
  if (rate === null || rate === undefined) return '未記入';
  return Math.round(rate * 1000) / 10 + '%';
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
    L.push(`── ${p.name} ${p.contractKnown ? '' : '(CONFIG.PAYROLL.CONTRACTS に未登録 → 全項目を計算)'}`);

    if (p.setup.count) {
      L.push(`  客室セットアップ  ${p.setup.count}件 × ${yenP_(P.SETUP.UNIT_PRICE)} = ${yenP_(p.setup.gross)}`
        + `   (対象行 ${p.setup.rooms}室 / 数え方=${P.SETUP.COUNT_UNIT})`);
      if (p.setup.deduction) {
        L.push(`     清掃減額         -${yenP_(p.setup.deduction)}  (達成率の効かせ方=${P.SHORTFALL.RATE_MODE})`);
      }
      L.push(`     差引後           ${yenP_(p.setup.amount)}`);
      p.setup.days.forEach(d => {
        let line = `       ${d.label}  ${d.rooms}  達成率 ${pctP_(d.rate)}`;
        if (d.gross !== d.net) line += `  ${yenP_(d.gross)} → ${yenP_(d.net)}`;
        else                   line += `  ${yenP_(d.net)}`;
        if (d.redoN) line += `  やり直し${d.redoN}箇所: ${d.redo}`;
        if (d.note)  line += `  ${d.note}`;
        L.push(line);
      });
    }

    if (p.bonus.headcount || p.bonus.excess) {
      L.push(`  特別報酬          採用=${P.BONUS.BASE}  → ${yenP_(bonusAmount_(p))}`);
      L.push(`     人数読み(その値=人数)   ${yenP_(p.bonus.headcount)}`);
      L.push(`     超過読み(その値=4人超過) ${yenP_(p.bonus.excess)}`);
      p.bonus.lines.forEach(s => L.push(`       ${s}`));
    }

    if (p.deep.days.length) {
      L.push(`  客室徹底清掃      ${yenP_(p.deep.amount)}`);
      p.deep.days.forEach(d => {
        L.push(`       ${d.date}  ${d.pt}pt → ${yenP_(d.amount)} ${d.note}  [${d.tasks.join(' / ')}]`);
      });
    }

    if (p.checkin.days.length) {
      L.push(`  チェックイン対応  A ${p.checkin.a}件 × ${yenP_(P.CHECKIN.PRICE_A)}`
        + ` / B ${p.checkin.b}件 × ${yenP_(P.CHECKIN.PRICE_B)} = ${yenP_(p.checkin.amount)}`);
      if (p.checkin.halfCut) {
        L.push(`     うち半日(W列) ${p.checkin.halfDays}件 で -${yenP_(p.checkin.halfCut)}`
          + ` (掛け率 ${P.CHECKIN.HALF_RATE})`);
      }
      L.push(`     ※${P.CHECKIN.TAX_NOTE}`);
      p.checkin.days.forEach(d => {
        L.push(`       ${d.date}  ${d.rooms}  ${d.type}  ${yenP_(d.amount)}`
          + (d.dinnerSrc ? `  [${d.dinnerSrc}]` : '')
          + (d.half ? `  半日 (${yenP_(d.full)} → ${yenP_(d.amount)})` : ''));
        const detail = [d.boardMeals, d.optMeals].filter(x => x).join('  ///  ');
        if (detail) L.push(`           食事: ${detail}`);
      });
    }

    L.push(`  ── 合計 ${yenP_(p.total)}`);
    if (!p.contractKnown) {
      // 何も当たっていない人を黙って落とさない
      if (!p.setup.count && !p.deep.days.length && !p.checkin.days.length) {
        L.push('     (該当する業務が0件)');
      }
    }
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
  L.push(`  セットアップ1件の単位 : ${P.SETUP.COUNT_UNIT}  (day = 同じ日に1F+2F掃除しても1件)`);
  L.push(`  両階とも「特別」の日   : ${P.SPECIAL_DAY.BOTH_FLOORS_PT}pt 相当`
    + ` = ${yenP_(deepCleanAmount_(P.SPECIAL_DAY.BOTH_FLOORS_PT).amount)} (セットアップは付けない)`);
  L.push(`  片階だけ「特別」の日   : 布団${P.SPECIAL_DAY.ONE_FLOOR_FUTONS}個の入替清掃として扱う`
    + ` (= その日のセットアップ1件に含める / 特別報酬なし)`);
  L.push(`  「特」シート           : ${P.DEEP.USE_SHEET ? '読む' : '読まない (発注者指示)'}`);
  L.push(`  特別報酬「その値」     : ${P.BONUS.BASE}`);
  L.push(`  特別報酬の単位         : ${P.BONUS.PER_ROOM ? '部屋ごとに積む' : '日ごとに1回'}`);
  L.push(`  清掃達成率の効かせ方   : ${P.SHORTFALL.RATE_MODE}`
    + (P.SHORTFALL.RATE_MODE === 'contract' ? ` (×${P.SHORTFALL.CONTRACT_RATIO})` : ''));
  L.push(`  複数行のまとめ方       : ${P.SHORTFALL.AGGREGATE}`);
  L.push(`  やり直し1箇所の減額   : ${yenP_(P.SHORTFALL.REDO_DEDUCTION)}`
    + (P.SHORTFALL.REDO_DEDUCTION ? '' : ' (0 = 金額には効かせず内訳に出すだけ)'));
  L.push(`  接客半日(W列)の掛け率 : `
    + (P.CHECKIN.HALF_ENABLED ? `${P.CHECKIN.HALF_RATE} ★契約書に根拠が無い列。要確認` : '見ない'));

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
  L.push(`接客担当が入っている到着日: ${keys.length}`);
  L.push('');

  const missLabel = [];   // ① 食事はあるが夕食と判定しなかった
  const missBoard = [];   // ② LatestOptions にあるがボードR列が空
  const noMeal    = [];   // ③ 食事の記載がどこにも無い
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
    if (optMeals.length && !boardMeals.length) {
      missBoard.push(`${u.date} ${u.server}: `
        + optMeals.map(o => `${o.room || '?'} ${o.guestName} → ${o.meal}`).join(' | '));
    }
    if (!boardMeals.length && !optMeals.length) {
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
  L.push('── ③ 食事の記載がどこにも無い日 ───────────────────────');
  L.push('   注文が無ければ正しく A。WhatsApp等で受けた注文があるなら');
  L.push('   CleaningOverride の食事列に書くと反映される。');
  if (noMeal.length) noMeal.forEach(x => L.push(`   ・${x}`));
  else L.push('   なし');

  Logger.log(L.join('\n'));
  return { month: month, a: nA, b: nB, missLabel: missLabel, missBoard: missBoard, noMeal: noMeal };
}

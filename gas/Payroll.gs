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
  const deep  = readDeepCleanForPayroll_();
  const res   = computeStaffPay(board, deep, month);
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
  const rows = sh.getRange(2, 1, last - 1, C.UPDATED_AT).getDisplayValues();

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

// ── 計算本体 (シートに触らない。テストから直接呼べる) ──────────

/**
 * @param {Array<Object>} board readBoardForPayroll_() の出力
 * @param {Array<Object>} deep  readDeepCleanForPayroll_() の出力
 * @param {string} month 'yyyy-MM'
 */
function computeStaffPay(board, deep, month) {
  const P = CONFIG.PAYROLL;

  // 日付+部屋で引けるようにしておく (直前宿泊者の人数を遡るため)
  const byKey = {};
  board.forEach(r => { byKey[r.date + '_' + r.room] = r; });

  const people = {};
  const warnings = [];

  function person(name) {
    if (!people[name]) {
      people[name] = {
        name:     name,
        setup:    { count: 0, rooms: 0, days: [], amount: 0 },
        bonus:    { headcount: 0, excess: 0, lines: [] },
        deep:     { days: [], amount: 0 },
        checkin:  { a: 0, b: 0, days: [], amount: 0 },
        total:    0,
      };
    }
    return people[name];
  }

  const inMonth = r => String(r.date).slice(0, 7) === month;

  // ── 客室セットアップ業務 ────────────────────────────────
  const setupSeen = {};   // 担当者+単位 の重複排除
  board.filter(inMonth).forEach(r => {
    if (!r.cleaner || isIgnoredStaffName_(r.cleaner)) return;
    if (P.SETUP.REQUIRE_KIND && !r.cleanKind) return;
    if (P.SETUP.EXCLUDE_SPECIAL && isSpecialCleanKind_(r.cleanKind)) return;

    const p = person(r.cleaner);
    p.setup.rooms++;

    const unitKey = (P.SETUP.COUNT_UNIT === 'room')
      ? r.cleaner + '|' + r.date + '|' + r.room
      : r.cleaner + '|' + r.date;
    if (!setupSeen[unitKey]) {
      setupSeen[unitKey] = true;
      p.setup.count++;
      p.setup.days.push(r.date + (P.SETUP.COUNT_UNIT === 'room' ? ' ' + r.room : ''));
    }

    // 特別報酬。人数は部屋ごとに違うので部屋単位で積む。
    if (P.BONUS.PER_ROOM || setupSeen[unitKey + '|bonus'] !== true) {
      setupSeen[unitKey + '|bonus'] = true;
      addSetupBonus_(p, r, byKey, warnings);
    }
  });

  Object.keys(people).forEach(n => {
    const p = people[n];
    p.setup.amount = p.setup.count * P.SETUP.UNIT_PRICE;
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
      nightByDay[k] = { server: r.server, date: r.date, dinner: false, rooms: [] };
    }
    nightByDay[k].rooms.push(r.room);
    if (hasDinner_(r.meal)) nightByDay[k].dinner = true;
  });

  Object.keys(nightByDay).forEach(k => {
    const u = nightByDay[k];
    const p = person(u.server);
    const amount = u.dinner ? P.CHECKIN.PRICE_B : P.CHECKIN.PRICE_A;
    if (u.dinner) p.checkin.b++; else p.checkin.a++;
    p.checkin.amount += amount;
    p.checkin.days.push({
      date: u.date, rooms: u.rooms.join('+'),
      type: u.dinner ? 'B(CI+仕出し)' : 'A(CIのみ)', amount: amount,
    });
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
 * 食事列(R)に夕食(仕出し)が入っているか。
 *  ・CONFIG.MEALS の kind:'dinner' のラベルを見る
 *    (Lodgify由来の "(paid) " 接頭辞が付いていても部分一致で拾える)
 *  ・CleaningOverride に手書きされる日本語は DINNER_HINTS で拾う
 *  ・朝食 (Ochazuke Breakfast) は仕出しに数えない
 */
function hasDinner_(meal) {
  const s = String(meal || '');
  if (!s) return false;
  const low = s.toLowerCase();
  const hit = CONFIG.MEALS.some(m =>
    m.kind === 'dinner' && low.indexOf(String(m.label).toLowerCase()) >= 0);
  if (hit) return true;
  return CONFIG.PAYROLL.CHECKIN.DINNER_HINTS.some(re => re.test(s));
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
      L.push(`  客室セットアップ  ${p.setup.count}件 × ${yenP_(P.SETUP.UNIT_PRICE)} = ${yenP_(p.setup.amount)}`
        + `   (対象行 ${p.setup.rooms}室 / 数え方=${P.SETUP.COUNT_UNIT})`);
      L.push(`     対象日: ${p.setup.days.join(', ')}`);
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
      L.push(`     ※${P.CHECKIN.TAX_NOTE}`);
      p.checkin.days.forEach(d => {
        L.push(`       ${d.date}  ${d.rooms}  ${d.type}  ${yenP_(d.amount)}`);
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
  L.push(`  徹底清掃の行を除外    : ${P.SETUP.EXCLUDE_SPECIAL}`);
  L.push(`  特別報酬「その値」     : ${P.BONUS.BASE}`);
  L.push(`  特別報酬の単位         : ${P.BONUS.PER_ROOM ? '部屋ごとに積む' : '日ごとに1回'}`);

  Logger.log(L.join('\n'));
  return L.join('\n');
}

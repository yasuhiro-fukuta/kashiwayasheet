/**
 * ============================================================
 *  OrderAnnotate.gs — 突合結果を注文確認票のメモに書く  v1.00
 * ============================================================
 *  食事予約表 (LatestOptions) と ほなみや注文確認票 を突き合わせて、
 *  「直すべき値」を 注文確認票の日付セルのメモ として書き添える。
 *
 *  ★値は書き換えない。メモ (Range.setNote) だけを使う。
 *    数量そのものを自動で直すと、どちらが書いた数字なのか分からなく
 *    なる。直すかどうかは人が決める。
 *
 *  ★Apps Script から触れるのは「メモ」まで。
 *    返信の付く「コメント」(スレッド) は SpreadsheetApp では作れず、
 *    Drive API を足してもセルへの紐付けが安定しない。
 *
 *  人が書いたメモは消さない。
 *    メモの中身を MARKER で区切り、MARKER より後ろだけを書き換える。
 *
 *  入口:
 *    previewOrderSheetNotes()  … 何を書くかログに出すだけ (書き込みなし)
 *    annotateOrderSheet()      … 実際にメモを書く
 *    runOrderAnnotateOnly()    … メニュー用。当月+翌月をまとめて
 *    clearOrderSheetNotes()    … 柏屋が書いた注記だけを消す
 * ============================================================
 */

// ── 入口 ────────────────────────────────────────────────────

/** メニュー用。対象月をまとめて処理する。 */
function runOrderAnnotateOnly() {
  const r = annotateOrderSheetMonths(false);
  Logger.log(formatAnnotateResult_(r));
  return r;
}

/** 書く内容をログに出すだけ。シートには触らない。 */
function previewOrderSheetNotes(ym) {
  const r = ym ? annotateOrderSheet(ym, true) : annotateOrderSheetMonths(true);
  Logger.log(formatAnnotateResult_(r));
  return r;
}

/** 柏屋が書いた注記だけを消す (人のメモは残す)。 */
function clearOrderSheetNotes(ym) {
  const months = ym ? [normalizePayrollMonth_(ym)] : annotateTargetMonths_();
  const out = [];
  months.forEach(m => out.push(annotateOneMonth_(m, { clearOnly: true, dryRun: false })));
  const r = { months: out, dryRun: false, clearOnly: true };
  Logger.log(formatAnnotateResult_(r));
  return r;
}

/** 当月+翌月 (MONTHS_AHEAD ぶん) をまとめて。 */
function annotateOrderSheetMonths(dryRun) {
  const out = [];
  annotateTargetMonths_().forEach(m => {
    out.push(annotateOneMonth_(m, { clearOnly: false, dryRun: !!dryRun }));
  });
  return { months: out, dryRun: !!dryRun, clearOnly: false };
}

/** 1か月ぶん。ym 省略で当月。 */
function annotateOrderSheet(ym, dryRun) {
  const month = normalizePayrollMonth_(ym
    || Utilities.formatDate(todayJst(), CONFIG.TZ, 'yyyy-MM'));
  return { months: [annotateOneMonth_(month, { clearOnly: false, dryRun: !!dryRun })],
           dryRun: !!dryRun, clearOnly: false };
}

/** 毎時バッチから呼ぶ。設定で切れるようにしてある。 */
function annotateOrderSheetFromBatch() {
  const A = CONFIG.ORDER_ANNOTATE;
  if (!A.ENABLED || !A.IN_BATCH) return { skipped: '設定で無効' };
  return annotateOrderSheetMonths(false);
}

/** 対象月の一覧。 */
function annotateTargetMonths_() {
  const A = CONFIG.ORDER_ANNOTATE;
  const base = todayJst();
  const out = [];
  for (let i = 0; i <= (A.MONTHS_AHEAD || 0); i++) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    out.push(Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM'));
  }
  return out;
}

// ── 本体 ────────────────────────────────────────────────────

/**
 * 1か月ぶんのメモを組み立てて書く。
 *  @param {string} month 'yyyy-MM'
 *  @param {{clearOnly: boolean, dryRun: boolean}} opt
 */
function annotateOneMonth_(month, opt) {
  const A = CONFIG.ORDER_ANNOTATE;
  const res = { month: month, ok: false, reason: '',
                written: 0, cleared: 0, unplaced: [], notes: [], sheetName: '' };

  //  ── 書き先のシートを開く ──
  const id = PropertiesService.getScriptProperties()
    .getProperty(CONFIG.ORDER_EXPORT.PROP_TARGET_ID);
  if (!id) {
    res.reason = '注文確認票のIDが未設定 (setOrderExportTargetId を1回実行してください)';
    return res;
  }
  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (e) {
    res.reason = `注文確認票を開けません (${e.message || e})`;
    return res;
  }

  const sheets = findOrderSheetsForMonth_(ss, month);
  if (!sheets.length) {
    res.reason = `注文確認票に ${month} のタブがありません`;
    return res;
  }

  //  ── 突合のもう片方 (食事予約表) を読む ──
  //  ★注文確認票の側は「書き先のタブそのもの」から読む。
  //    一次転記タブと足し合わせてはいけない。足すと、一次転記には
  //    あるがこの表には無い注文が「一致」に見えてしまい、
  //    肝心の書き漏れを教えられなくなる。
  let optRows = [];
  if (!opt.clearOnly) {
    try {
      optRows = readOptionRowsWithDeleted_()
        .filter(o => o.checkin.slice(0, 7) === month);
    } catch (e) {
      res.reason = `食事予約表を読めません (${e.message || e})`;
      return res;
    }
  }
  const today = fmtDate(todayJst());

  sheets.forEach(sh => {
    const r = annotateOneSheet_(sh, month, optRows, today, opt);
    res.written += r.written;
    res.cleared += r.cleared;
    r.unplaced.forEach(x => res.unplaced.push(x));
    r.notes.forEach(x => res.notes.push(x));
    res.sheetName = res.sheetName ? `${res.sheetName} + ${sh.getName()}` : sh.getName();
  });

  res.ok = true;
  if (res.written > (A.MAX_CELLS_PER_RUN || 200)) {
    res.reason = '上限に達したため途中で止めました';
  }
  return res;
}

/**
 * 1枚のタブにメモを書く。
 *  注記は「日付セル」に付ける。
 *   ・どの日にも必ずある
 *   ・1日ぶんの指摘をまとめて1つのメモに書ける
 *   ・品目セルに散らすと、品目が増減したとき古い注記が取り残される
 */
function annotateOneSheet_(sh, month, optRows, today, opt) {
  const A = CONFIG.ORDER_ANNOTATE;
  const out = { written: 0, cleared: 0, unplaced: [], notes: [] };

  const last = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (last < 2 || lastCol < 1) return out;
  const values = sh.getRange(1, 1, last, lastCol).getDisplayValues();
  const layout = scanOrderSheet(values, month);
  //  年月と「日付」「注文品」の見出しが無いタブ (メモ用の小さなタブなど)
  //  は表として読めない。触らない。
  if (!Object.keys(layout.dayCell).length) return out;

  //  ── どのセルに何を書くか ──
  const want = {};   // 'row,col' → Array<string>
  if (!opt.clearOnly) {
    const audit = buildOrderSheetAudit(month, layout.entries, optRows, today);
    buildAnnotateMessages_(month, audit).forEach(msg => {
      const cell = layout.dayCell[`${msg.date}|${msg.floor}`];
      if (!cell) { out.unplaced.push(msg); return; }
      const k = `${cell.row},${cell.col}`;
      if (!want[k]) want[k] = [];
      want[k].push(msg.text);
    });
  }

  //  ── 既にあるメモを読む。消すのは柏屋が書いた部分だけ ──
  const cells = {};
  Object.keys(layout.dayCell).forEach(dk => {
    const c = layout.dayCell[dk];
    cells[`${c.row},${c.col}`] = c;
  });
  Object.keys(want).forEach(k => {
    if (cells[k]) return;
    const p = k.split(',');
    cells[k] = { row: Number(p[0]), col: Number(p[1]) };
  });

  const keys = Object.keys(cells).sort();
  let touched = 0;
  keys.forEach(k => {
    if (touched >= (A.MAX_CELLS_PER_RUN || 200)) return;
    const c = cells[k];
    const rng = sh.getRange(c.row, c.col);
    const cur = String(rng.getNote() || '');
    const human = splitKashiwayaNote_(cur).human;
    const body = want[k] ? want[k].join('\n') : '';

    const next = body
      ? capNote_((human ? human.replace(/\s+$/, '') + '\n\n' : '') + A.MARKER + '\n' + body)
      : human.replace(/\s+$/, '');

    if (next === cur) return;
    touched++;
    if (body) out.written++; else out.cleared++;
    out.notes.push(`${sh.getName()}!${columnLetter_(c.col)}${c.row}`
      + (body ? `\n${body}` : ' → 注記を消す'));
    if (opt.dryRun) return;

    rng.setNote(next);
    if (A.SET_BACKGROUND && body) rng.setBackground(A.BACKGROUND);
  });

  return out;
}

/**
 * メモを「人が書いた部分」と「柏屋が書いた部分」に分ける。
 *  目印が無ければ全部が人の部分。
 */
function splitKashiwayaNote_(note) {
  const marker = CONFIG.ORDER_ANNOTATE.MARKER;
  const s = String(note || '');
  const i = s.indexOf(marker);
  if (i < 0) return { human: s, mine: '' };
  return { human: s.slice(0, i), mine: s.slice(i + marker.length) };
}

/** 長すぎるメモを切る。開くのが重くなるのを防ぐ。 */
function capNote_(s) {
  const max = CONFIG.ORDER_ANNOTATE.MAX_NOTE_CHARS || 1200;
  const t = String(s || '');
  return (t.length <= max) ? t : t.slice(0, max - 3) + '...';
}

/** 列番号 → 'A' 'B' ... 'AA'。 */
function columnLetter_(col) {
  let n = Number(col), s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── 文面 ────────────────────────────────────────────────────

/**
 * 突合の結果から、セルに書く文面を組み立てる。
 *  シートに触らないのでテストできる。
 *  @return {Array<{date, floor, text}>}
 */
function buildAnnotateMessages_(month, audit) {
  const out = [];

  //  ① 転記漏れ … 確認票に行が無い
  audit.missing.forEach(m => {
    const L = [`⚠ 書き漏れ  ${m.room} ${m.name}`];
    L.push('   食事予約表にあるのに、この表に見当たりません。');
    Object.keys(m.opt.counts).sort().forEach(lb => {
      L.push(`   ・${lb} ${m.opt.counts[lb]}名`
        + `  →  ${portionsToSetText_(lb, m.opt.counts[lb])} と書いてください`);
    });
    m.opt.unknown.forEach(u => L.push(`   ・⚠人数が読めません: ${u}`));
    (m.opt.presumed || []).forEach(u => L.push(`   ・※${u}`));
    out.push({ date: m.date, floor: m.room, text: L.join('\n') });
  });

  //  ② 階違い … 確認票の書かれている側に出す
  audit.floorMismatch.forEach(m => {
    const L = [`⚠ 階が違います  ${m.name}`];
    L.push(`   食事予約表では ${m.room} です (この表では ${m.sheetFloor})。`);
    annotateDiffLines_(L, m).forEach(x => L.push(x));
    out.push({ date: m.date, floor: m.sheetFloor || m.room, text: L.join('\n') });
  });

  //  ③ 数量違い
  audit.qtyMismatch.forEach(m => {
    const L = [`⚠ 数量が合いません  ${m.room} ${m.name}`];
    annotateDiffLines_(L, m).forEach(x => L.push(x));
    out.push({ date: m.date, floor: m.room, text: L.join('\n') });
  });

  //  ④ 確認票にしか無い … 消すとは限らないので「確認」までに留める
  audit.extraLive.forEach(x => {
    const p = x.key.split('|');
    const nm = x.rows.map(e => e.name).filter(v => v)[0] || '(氏名なし)';
    const L = [`? 食事予約表に見当たりません  ${nm}`];
    L.push(`   ${x.rows.map(e => `${e.item} x${e.qty}`).join(' / ')}`);
    L.push('   直接受けた注文ならそのままで結構です。');
    out.push({ date: p[0], floor: p[1], text: L.join('\n') });
  });

  //  ⑤ 取消 … 確認票に残っているものだけ
  audit.cancelled.forEach(o => {
    if (!audit.sheetByKey[`${o.checkin}|${o.room}`]) return;
    const L = [`⚠ 取消です  ${o.room} ${o.guestName}`];
    L.push('   宿泊の予約が無くなりました。この注文は取り消してください。');
    L.push(`   (予約時の内容: ${o.meal})`);
    out.push({ date: o.checkin, floor: o.room, text: L.join('\n') });
  });

  //  同じセルに複数出るときの並びを安定させる
  out.sort((a, b) => (a.date + a.floor) < (b.date + b.floor) ? -1 : 1);
  return out;
}

/** 両側の人数を並べ、直すべきセット数まで書く。 */
function annotateDiffLines_(L, m) {
  const add = [];
  const labels = [];
  Object.keys(m.opt.counts).forEach(k => { if (labels.indexOf(k) < 0) labels.push(k); });
  Object.keys(m.sheet.counts).forEach(k => { if (labels.indexOf(k) < 0) labels.push(k); });
  labels.sort().forEach(lb => {
    const a = m.opt.counts[lb] || 0;
    const b = m.sheet.counts[lb] || 0;
    if (a === b) {
      add.push(`   ・${lb} ${a}名  ✓`);
      return;
    }
    const diff = (b < a) ? `${a - b}名 不足` : `${b - a}名 余分`;
    add.push(`   ・${lb}  予約 ${a}名 / この表 ${b}名  (${diff})`);
    add.push(`       →  ${portionsToSetText_(lb, a)} にしてください`);
  });
  m.opt.unknown.forEach(u => add.push(`   ・⚠予約の人数が読めません: ${u}`));
  m.sheet.unknown.forEach(u => add.push(`   ・⚠この表の品目が読めません: ${u}`));
  //  当て推量で数えた分は黙っておかない
  (m.opt.presumed || []).forEach(u => add.push(`   ・※${u}`));
  return add;
}

// ── ログ ────────────────────────────────────────────────────

function formatAnnotateResult_(r) {
  const A = CONFIG.ORDER_ANNOTATE;
  const L = [];
  L.push('════════════════════════════════════════════');
  L.push('  注文確認票への注記'
    + (r.dryRun ? '  ※書き込みなし (下見)' : '')
    + (r.clearOnly ? '  ※消すだけ' : ''));
  L.push('════════════════════════════════════════════');
  if (r.skipped) { L.push(`実行していません: ${r.skipped}`); return L.join('\n'); }

  L.push('セルの「メモ」に書きます。値は書き換えません。');
  L.push(`人が書いたメモは残し、「${A.MARKER.split('\n').pop()}」より後ろだけ入れ替えます。`);

  (r.months || []).forEach(m => {
    L.push('');
    L.push(`── ${m.month} ${m.sheetName ? `「${m.sheetName}」` : ''} ──`);
    if (!m.ok) { L.push(`   ★${m.reason}`); return; }
    L.push(`   書く ${m.written}件 / 消す ${m.cleared}件`);
    if (m.reason) L.push(`   ※${m.reason}`);
    m.notes.forEach(n => {
      L.push('');
      L.push(`   [${n.split('\n')[0]}]`);
      n.split('\n').slice(1).forEach(x => L.push(`   ${x}`));
    });
    if (m.unplaced.length) {
      L.push('');
      L.push('   ★書く場所が見つからない (その日の行がこの表に無い)');
      m.unplaced.forEach(u => {
        L.push(`     ${u.date} ${u.floor}`);
        u.text.split('\n').forEach(x => L.push(`       ${x}`));
      });
    }
  });
  return L.join('\n');
}

/**
 * ============================================================
 *  BoardNote.gs — 清掃ボードの A列・D列に指摘をメモで出す  v1.00
 * ============================================================
 *  指摘事項シートを見に行かなくても、清掃ボードを見るだけで
 *  「ここを埋めてください」が分かるようにする。
 *
 *  ★値は絶対に書き換えない。メモ (Range.setNote) だけを使う。
 *    A列(清掃担当) と D列(接客担当) は人の領域。
 *
 *  ★Apps Script から触れるのは「メモ」まで。
 *    返信の付く「コメント」(スレッド) は SpreadsheetApp では作れない。
 *
 *  ★人が書いたメモは消さない。
 *    メモを MARKER で区切り、MARKER より後ろだけを入れ替える。
 *
 *  ★解消したらメモは消える。
 *    毎回ボードの全行を見て「いま出すべきメモ」を作り直すので、
 *    直った行・対象期間から外れた行のメモは自動で消える。
 *
 *  出す指摘は CONFIG.BOARD_NOTE.RULES に絞ってある (2026-10-09 時点で3つ)。
 *  判定そのものは Consistency.gs の collectIssues() を使う。
 *  別に判定すると、指摘事項シートとメモで違うことを言い出す。
 *
 *  入口:
 *    previewBoardNotes()  … 何を書くかログに出すだけ (書き込みなし)
 *    runBoardNoteOnly()   … 実際にメモを書く
 *    clearBoardNotes()    … 柏屋が書いたメモだけを消す
 * ============================================================
 */

// ── 入口 ────────────────────────────────────────────────────

/** メニュー用。メモを書く。 */
function runBoardNoteOnly() {
  const r = annotateBoardNotes(null, false);
  Logger.log(formatBoardNoteResult_(r));
  return r;
}

/** 書く内容をログに出すだけ。シートには触らない。 */
function previewBoardNotes() {
  const r = annotateBoardNotes(null, true);
  Logger.log(formatBoardNoteResult_(r));
  return r;
}

/** 柏屋が書いたメモだけを消す (人のメモは残す)。 */
function clearBoardNotes() {
  const r = annotateBoardNotes([], false);   // 指摘0件 = 全部消す
  Logger.log(formatBoardNoteResult_(r));
  return r;
}

/**
 * 毎時バッチから呼ぶ。
 *  @param {Array} [issues] checkConsistency() が集めた指摘。
 *                          渡すとボードを2回読まずに済む。
 */
function annotateBoardNotesFromBatch(issues) {
  const B = CONFIG.BOARD_NOTE || {};
  if (!B.ENABLED || !B.IN_BATCH) return { skipped: '設定で無効' };
  return annotateBoardNotes(issues || null, false);
}

// ── 本体 ────────────────────────────────────────────────────

/**
 * 清掃ボードの A列・D列のメモを、いまの指摘に合わせて作り直す。
 *
 *  @param {Array|null} issues 指摘の配列。null なら collectIssues() を呼ぶ。
 *                             [] を渡すと「指摘0件」= 全部消す。
 *  @param {boolean} dryRun true ならシートに触らない。
 */
function annotateBoardNotes(issues, dryRun) {
  const B = CONFIG.BOARD_NOTE || {};
  const C = CONFIG.COL_CLEAN;
  const res = { ok: false, reason: '', written: 0, cleared: 0,
                notes: [], unplaced: [], dryRun: !!dryRun };

  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.CLEANING);
  if (!sh) { res.reason = 'CleaningBoard シートが見つかりません'; return res; }
  const last = sh.getLastRow();
  if (last < 2) { res.ok = true; return res; }

  //  ── 行番号を引けるようにする ──
  //  E列(キー) は 'yyyy-MM-dd_1F'。指摘の pk の前半と同じ。
  //  行の並び順には頼らない (並べ替えられても壊れないようにする)。
  const keys = sh.getRange(2, C.KEY, last - 1, 1).getDisplayValues();
  const rowOf = {};
  keys.forEach((r, i) => {
    const k = String(r[0] || '').trim();
    if (k && !rowOf[k]) rowOf[k] = i + 2;
  });

  //  ── いま出すべきメモ ──
  const list = (issues === null || issues === undefined) ? collectIssues() : issues;
  const want = {};   // 'row,col' → Array<string>
  list.forEach(it => {
    const m = boardNoteRuleOf_(it);
    if (!m) return;                       // メモにしないルール
    const rowKey = String(it.pk || '').split('#')[0];
    const row = rowOf[rowKey];
    if (!row) { res.unplaced.push(it); return; }
    const k = `${row},${m.col}`;
    if (!want[k]) want[k] = [];
    if (want[k].indexOf(m.text) < 0) want[k].push(m.text);
  });

  //  ── 既にあるメモを読む (A列とD列をまとめて1回ずつ) ──
  const cols = boardNoteColumns_();
  const cur = {};
  cols.forEach(col => {
    const notes = sh.getRange(2, col, last - 1, 1).getNotes();
    notes.forEach((r, i) => { cur[`${i + 2},${col}`] = String(r[0] || ''); });
  });

  //  ── 差分だけ書く ──
  const max = B.MAX_CELLS_PER_RUN || 300;
  let touched = 0;
  Object.keys(cur).sort(compareCellKey_).forEach(k => {
    if (touched >= max) { res.reason = '上限に達したため途中で止めました'; return; }
    const body = want[k] ? want[k].map(t => `⚠ ${t}`).join('\n') : '';
    const next = buildBoardNote_(cur[k], body);
    if (next === cur[k]) return;

    touched++;
    if (body) res.written++; else res.cleared++;
    const p = k.split(',');
    res.notes.push({
      cell: `${columnLetter_(Number(p[1]))}${p[0]}`,
      body: body,
    });
    if (dryRun) return;
    sh.getRange(Number(p[0]), Number(p[1])).setNote(next);
  });

  res.ok = true;
  return res;
}

/** 指摘1件 → {col, text}。メモにしないルールなら null。 */
function boardNoteRuleOf_(issue) {
  const B = CONFIG.BOARD_NOTE || {};
  const R = B.RULES || {};
  if (String(issue.sheet || '') !== CONFIG.SHEET.CLEANING) return null;
  //  pk = 'yyyy-MM-dd_1F#ruleId'。ruleId に '.' が入ることがある
  //  (unknownStaff.清掃) が、そのルールはメモにしないので影響しない。
  const ruleId = String(issue.pk || '').split('#')[1] || '';
  return R[ruleId] || null;
}

/** メモを出す列の一覧 (重複を除く)。 */
function boardNoteColumns_() {
  const R = (CONFIG.BOARD_NOTE || {}).RULES || {};
  const out = [];
  Object.keys(R).forEach(k => {
    const c = Number(R[k].col);
    if (c > 0 && out.indexOf(c) < 0) out.push(c);
  });
  return out.sort((a, b) => a - b);
}

/**
 * 人が書いた部分を残したまま、柏屋の部分を入れ替える。
 *  body が空なら柏屋の部分を取り除く。
 */
function buildBoardNote_(current, body) {
  const B = CONFIG.BOARD_NOTE || {};
  const human = splitBoardNote_(current).human.replace(/\s+$/, '');
  if (!body) return human;
  return (human ? human + '\n\n' : '') + B.MARKER + '\n' + body;
}

/** メモを「人が書いた部分」と「柏屋が書いた部分」に分ける。 */
function splitBoardNote_(note) {
  const marker = (CONFIG.BOARD_NOTE || {}).MARKER || '';
  const s = String(note || '');
  const i = marker ? s.indexOf(marker) : -1;
  if (i < 0) return { human: s, mine: '' };
  return { human: s.slice(0, i), mine: s.slice(i + marker.length) };
}

/** 'row,col' を 行 → 列 の順で並べる (文字列比較だと 10 < 2 になる)。 */
function compareCellKey_(a, b) {
  const pa = a.split(','), pb = b.split(',');
  const d = Number(pa[0]) - Number(pb[0]);
  return d !== 0 ? d : Number(pa[1]) - Number(pb[1]);
}

// ── ログ ────────────────────────────────────────────────────

function formatBoardNoteResult_(r) {
  const L = [];
  L.push('════════════════════════════════════════════');
  L.push('  清掃ボードへの指摘メモ' + (r.dryRun ? '  ※書き込みなし (下見)' : ''));
  L.push('════════════════════════════════════════════');
  if (r.skipped) { L.push(`実行していません: ${r.skipped}`); return L.join('\n'); }
  if (!r.ok)     { L.push(`★${r.reason}`); return L.join('\n'); }

  L.push('A列・D列のセルの「メモ」に書きます。値は書き換えません。');
  L.push('人が書いたメモは残し、目印より後ろだけ入れ替えます。');
  L.push(`書く ${r.written}件 / 消す ${r.cleared}件`);
  if (r.reason) L.push(`※${r.reason}`);

  const put = r.notes.filter(n => n.body);
  const del = r.notes.filter(n => !n.body);

  if (put.length) {
    L.push('');
    L.push('── 書くメモ ──────────────────────────────');
    put.forEach(n => {
      L.push(`   ${n.cell}`);
      n.body.split('\n').forEach(x => L.push(`     ${x}`));
    });
  }
  if (del.length) {
    L.push('');
    L.push('── 消すメモ (解消したもの) ─────────────────');
    L.push(`   ${del.map(n => n.cell).join(' ')}`);
  }
  if (r.unplaced && r.unplaced.length) {
    L.push('');
    L.push('── ★書く場所が見つからない ───────────────');
    L.push('   指摘のキーに合う行が清掃ボードにありません。');
    r.unplaced.forEach(it => L.push(`   ${it.pk}  ${it.issue}`));
  }
  if (!put.length && !del.length) {
    L.push('');
    L.push('変更はありません。');
  }
  return L.join('\n');
}

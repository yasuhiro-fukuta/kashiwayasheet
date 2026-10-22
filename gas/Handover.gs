/**
 * ============================================================
 *  Handover.gs - 清掃全体申し送り事項  v1.00 (2026-10-22 社長指示)
 * ============================================================
 *  福田から全清掃スタッフへの申し送り事項を、年月日をキーに1行ずつ持つ。
 *  入力: O_データベース管理 で社長が口頭で伝える → Claude が
 *        書き込み API (handover.append) で追記する。
 *  出力: 座敷童（スタッフモード）が doGet の handover で読み、
 *        「【スタッフ】○月から○月の清掃申し送り事項は？」に答える。
 *  ★人が書くシート。GAS は追記と読み取りだけで、消したり並べ替えたりしない。
 * ============================================================
 */

const HANDOVER_SHEET_ = '清掃全体申し送り事項';
const HANDOVER_HEADER_ = ['日付', '申し送り事項', '記入者', '記入日時'];

function ensureHandoverSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(HANDOVER_SHEET_);
  if (sh) return sh;
  sh = ss.insertSheet(HANDOVER_SHEET_);
  sh.getRange(1, 1, 1, HANDOVER_HEADER_.length).setValues([HANDOVER_HEADER_])
    .setFontWeight('bold').setBackground('#FFF2CC');
  sh.setFrozenRows(1);
  sh.getRange(2, 1, 1000, 1).setNumberFormat('@');
  sh.setColumnWidth(2, 600);
  return sh;
}

/** 全行を {date, text, by} で返す (日付順)。doGet から呼ぶ。 */
function readHandover_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(HANDOVER_SHEET_);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, HANDOVER_HEADER_.length).getDisplayValues();
  const out = [];
  rows.forEach(r => {
    const date = String(r[0] || '').trim().replace(/\//g, '-');
    const text = String(r[1] || '').trim();
    if (!date || !text) return;
    out.push({ date: date, text: text, by: String(r[2] || '').trim() });
  });
  out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return out;
}

/** 書き込み API: rows [{date:'yyyy-MM-dd', text, by?}] を末尾に足す。 */
function writeApiHandoverAppend_(rows) {
  requireRows_(rows);
  const sh = ensureHandoverSheet_();
  const now = nowJst_();
  const values = rows.map((r, i) => {
    const date = requireDate_(r.date, `rows[${i}].date`);
    const text = String(r.text || '').trim();
    if (!text) throw new Error(`rows[${i}].text が空です`);
    return [date, text, String(r.by || '福田').trim(), now];
  });
  const start = Math.max(sh.getLastRow(), 1) + 1;
  sh.getRange(start, 1, values.length, HANDOVER_HEADER_.length).setValues(values);
  SpreadsheetApp.flush();
  return { ok: true, sheet: HANDOVER_SHEET_, rows: values.length, firstRow: start };
}

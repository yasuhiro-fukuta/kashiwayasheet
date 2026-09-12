/**
 * ============================================================
 *  Staff.gs - 担当者一覧の自動生成 (v2.11)
 * ============================================================
 *  AppSheet の「わたしは誰か」ドロップダウンの選択肢になるシートを
 *  作る。CleaningBoard の A列(清掃) と D列(接客) に実際に入っている
 *  名前を拾って Staff シートに溜める。
 *
 *  ★突合は完全一致。だから名前を書き換えてはいけない。
 *    A列 = "ゆうｻﾝ" (半角カナ) なら Staff にも "ゆうｻﾝ" を入れる。
 *    正規化して "ゆうサン" にすると当番が1件も拾えなくなる。
 *    人が読む用の名前が欲しい場合は B列「表示名」を手で直す。
 *
 *  ★追記のみ。既存行は消さない。
 *    B列(表示名) と E列(有効) は人が手で編集する前提なので、
 *    バッチで上書きしない。辞めた人は E列を FALSE にすれば
 *    ドロップダウンから消える (行は残る)。
 *
 *  実データで確認した表記 (2026-09-12):
 *    清掃 … ゆか / ゆうｻﾝ / 松原ｻﾝ / まるこ / や
 *    接客 … や / まるこ / ななみ
 *    "-" は担当なしの意味なので取り込まない。
 * ============================================================
 */

/**
 * Staff シートを更新する。新しい名前があれば追記する。
 * @return {{added:number, total:number}}
 */
function setupStaffSheet() {
  const sh = ensureStaffSheet();
  const C = CONFIG.COL_STAFF;

  // 1. CleaningBoard から実際に使われている名前を集める
  const found = collectStaffNames();

  // 2. すでに Staff にある名前
  const last = sh.getLastRow();
  const existing = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 5).getValues().forEach(row => {
      const n = String(row[C.NAME - 1] || '').trim();
      if (n) existing[n] = true;
    });
  }

  // 3. 無いものだけ追記する
  const now = nowJst();
  const appends = [];
  Object.keys(found).sort().forEach(name => {
    if (existing[name]) return;
    const row = new Array(5).fill('');
    row[C.NAME - 1]       = name;
    row[C.DISPLAY - 1]    = name;            // 人が読みやすい名前に手で直してよい
    row[C.ROLE - 1]       = found[name].join('・');
    row[C.FIRST_SEEN - 1] = now;
    row[C.ACTIVE - 1]     = true;
    appends.push(row);
  });

  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, 5).setValues(appends);
    dlog(`Staff: ${appends.length} 名を追加 (${appends.map(r => r[0]).join(', ')})`);
  }

  const total = Object.keys(existing).length + appends.length;
  dlog(`Staff: 合計 ${total} 名`);
  return { added: appends.length, total: total };
}

/**
 * CleaningBoard の A列 / D列から担当者名を集める。
 *
 * @return {Object} 名前 → ['掃除','接客'] のような役割の配列
 */
function collectStaffNames() {
  const sh = getSheet(CONFIG.SHEET.CLEANING);
  const last = sh.getLastRow();
  const out = {};
  if (last <= 1) return out;

  const C = CONFIG.COL_CLEAN;
  const vals = sh.getRange(2, 1, last - 1, C.STAFF_NIGHT).getValues();

  const put = (raw, role) => {
    const n = String(raw == null ? '' : raw).trim();
    if (!n) return;
    if (CONFIG.STAFF.IGNORE.indexOf(n) >= 0) return;   // "-" など
    if (!out[n]) out[n] = [];
    if (out[n].indexOf(role) < 0) out[n].push(role);
  };

  vals.forEach(row => {
    put(row[C.STAFF_DAY - 1],   '掃除');   // A列
    put(row[C.STAFF_NIGHT - 1], '接客');   // D列
  });

  return out;
}

/**
 * Staff シートを用意する (無ければヘッダー付きで作成)
 */
function ensureStaffSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET.STAFF);
  if (sh) return sh;

  sh = ss.insertSheet(CONFIG.SHEET.STAFF);
  const header = ['名前(照合用)', '表示名', '役割', '初回検出', '有効'];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote(
    'CleaningBoard の A列(清掃)/D列(接客) と完全一致させる列。\n' +
    'ここを書き換えると当番が拾えなくなるので触らないこと。\n' +
    '人が読む名前を変えたい場合は B列「表示名」を直す。');
  sh.getRange(1, 5).setNote(
    'FALSE にするとアプリのドロップダウンから消える。行は残る。');
  sh.setColumnWidth(1, 130);
  sh.setColumnWidth(2, 130);
  sh.setColumnWidth(4, 150);
  return sh;
}

/**
 * メニューから実行する薄いラッパー
 */
function runStaffSetupOnly() {
  const r = setupStaffSheet();
  Logger.log(`Staff: +${r.added} / 合計 ${r.total} 名`);
}

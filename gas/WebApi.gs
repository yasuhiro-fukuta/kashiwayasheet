/**
 * ============================================================
 *  WebApi.gs - スタッフ向け 読み取り専用 Web API (v1)
 * ============================================================
 *  柏屋の AI チャットボット (kashiwaya-lp) のスタッフモードから
 *  清掃予定表を読むためのエンドポイント。
 *
 *  ★読み取り専用。どのシートにも一切書き込まない。
 *  ★既存の毎時バッチ (hourlySync / runBatch) とは独立。
 *    このファイルを消してもバッチは影響を受けない。
 *
 *  返すもの (JSON):
 *   - board   … CleaningBoard の直近35日前〜90日先。
 *               A〜D列(担当・種類・べ) と、質問回答に必要な列だけ。
 *               予約番号(M列)・IN/OUT詳細などは返さない。
 *   - special … 特シート (特別清掃タスク) 全件 + 未完了判定
 *   - staff   … Staff シートの有効な担当者名 (照合用の完全一致表記)
 *
 *  ── セットアップ (1回だけ) ──────────────────────────────
 *   1. エディタ ⚙ プロジェクトの設定 → スクリプトプロパティ に
 *        WEB_API_TOKEN = (長いランダム文字列)
 *      を追加する。
 *   2. デプロイ → 新しいデプロイ → 種類: ウェブアプリ
 *        実行ユーザー: 自分 / アクセスできるユーザー: 全員
 *      → 発行された URL を控える。
 *   3. 呼び出し側 (Vercel) に URL とトークンを環境変数で渡す。
 *      呼び出しは GET ?token=XXXX のみ。
 *
 *  ★gas/ を main に push しただけでは公開中のデプロイは
 *    更新されない。このファイルを変更したら
 *    デプロイ → デプロイを管理 → 新バージョン で反映すること。
 * ============================================================
 */

function doGet(e) {
  const token = PropertiesService.getScriptProperties().getProperty('WEB_API_TOKEN');
  const given = e && e.parameter ? String(e.parameter.token || '') : '';
  if (!token || !given || given !== token) {
    return jsonOut_({ error: 'unauthorized' });
  }

  try {
    return jsonOut_({
      generatedAt: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
      today: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'),
      board: readCleaningBoardSlice_(),
      special: readSpecialSheet_(),
      staff: readActiveStaff_(),
    });
  } catch (err) {
    return jsonOut_({ error: String(err && err.message || err) });
  }
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * CleaningBoard の直近ウィンドウを返す。
 * ★日付は getDisplayValues の「表示されている文字列」をそのまま使う。
 *   (シートのタイムゾーンが America/Los_Angeles のため、
 *    生の Date で読むと1日ずれることがある — HANDOFF.md 参照)
 */
function readCleaningBoardSlice_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.CLEANING);
  if (!sh) throw new Error('CleaningBoard シートが見つかりません');
  const last = sh.getLastRow();
  if (last < 2) return [];

  const C = CONFIG.COL_CLEAN;
  const rows = sh.getRange(2, 1, last - 1, C.UPDATED_AT).getDisplayValues();

  const DAY = 86400000;
  const now = Date.now();
  const from = Utilities.formatDate(new Date(now - 35 * DAY), CONFIG.TZ, 'yyyy-MM-dd');
  const to   = Utilities.formatDate(new Date(now + 90 * DAY), CONFIG.TZ, 'yyyy-MM-dd');

  const out = [];
  rows.forEach(r => {
    const date = String(r[C.DATE - 1] || '').trim();
    if (!date || date < from || date > to) return;

    const cleaner = String(r[C.STAFF_DAY - 1] || '').trim();
    const server  = String(r[C.STAFF_NIGHT - 1] || '').trim();
    const state   = String(r[C.STATE - 1] || '').trim();
    // 空室でどの担当も入っていない行は返しても意味がないので省く
    if (state === '空室' && !cleaner && !server) return;

    out.push({
      date: date,                                        // H列 (表示文字列)
      weekday: String(r[C.WEEKDAY - 1] || '').trim(),    // I列
      room: String(r[C.ROOM - 1] || '').trim(),          // J列
      cleaner: cleaner,                                  // A列 清掃担当
      cleanType: String(r[C.CLEAN_MANUAL - 1] || '').trim(),  // B列 種類
      setGuests: String(r[C.SET_GUESTS - 1] || '').trim(),    // C列 べ
      server: server,                                    // D列 接客担当
      guests: String(r[C.GUESTS - 1] || '').trim(),      // F列 泊人
      state: state,                                      // G列
      guestName: String(r[C.GUEST_NAME - 1] || '').trim(), // L列
      meal: String(r[C.MEAL - 1] || '').trim(),          // R列
      note: String(r[C.NOTE - 1] || '').trim(),          // S列
    });
  });
  return out;
}

/**
 * 特シート (特別清掃タスク)。
 * 未完了 = A列(対応者) と B列(完了日) がどちらも空。
 */
function readSpecialSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName('特');
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];

  const rows = sh.getRange(2, 1, last - 1, 4).getDisplayValues();
  const out = [];
  rows.forEach(r => {
    const naiyo = String(r[3] || '').trim();   // D列 内容
    if (!naiyo) return;
    const tanto = String(r[0] || '').trim();   // A列 対応者
    const done  = String(r[1] || '').trim();   // B列 完了日
    out.push({
      task: naiyo,
      pt: String(r[2] || '').trim(),           // C列 pt
      assignee: tanto,
      doneDate: done,
      pending: !tanto && !done,
    });
  });
  return out;
}

/**
 * Staff シートの有効な担当者名 (A列 = CleaningBoard と完全一致の表記)。
 */
function readActiveStaff_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.STAFF);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];

  const C = CONFIG.COL_STAFF;
  const rows = sh.getRange(2, 1, last - 1, C.ACTIVE).getDisplayValues();
  const out = [];
  rows.forEach(r => {
    const name = String(r[C.NAME - 1] || '').trim();
    const active = String(r[C.ACTIVE - 1] || '').trim().toUpperCase();
    if (name && active !== 'FALSE') out.push(name);
  });
  return out;
}

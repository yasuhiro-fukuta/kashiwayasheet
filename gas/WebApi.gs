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
 *               A〜D列(担当・種類・べ) と、質問回答に必要な列、
 *               X列(特別清掃箇所。予定・実績ともここで管理)。
 *               予約番号(M列)・IN/OUT詳細などは返さない。
 *   - staff   … Staff シートの有効な担当者名 (照合用の完全一致表記)
 *
 *  ※特シートは返さなくなった (2026-10-04)。特別清掃は
 *    CleaningBoard X列「特別清掃箇所」で管理する運用に変更。
 *
 *  ?part=menu を付けると、上記の代わりに「メニュー」シートの
 *  食事料金表だけを返す (menu)。ゲスト向けの料金回答にも使うため、
 *  宿泊者名などを含む board はこのモードでは一切返さない。
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

  const part = e && e.parameter ? String(e.parameter.part || '') : '';

  try {
    if (part === 'menu') {
      return jsonOut_({
        generatedAt: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
        menu: readMenuSheet_(),
      });
    }
    return jsonOut_({
      generatedAt: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
      today: Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd'),
      board: readCleaningBoardSlice_(),
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
  // X列(特別清掃箇所)まで読む。U〜X列は手動領域 (バッチのクリア対象外)
  const rows = sh.getRange(2, 1, last - 1, C.SPECIAL_SPOT).getDisplayValues();

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
    const specialSpot = String(r[C.SPECIAL_SPOT - 1] || '').trim();
    // 空室でどの担当も入っていない行は返しても意味がないので省く
    // (ただし特別清掃箇所が書かれている行は空室日でも残す)
    if (state === '空室' && !cleaner && !server && !specialSpot) return;

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
      specialSpot: specialSpot,                          // X列 特別清掃箇所
    });
  });
  return out;
}

/**
 * メニューシート (食事料金表)。E列「有効」が FALSE の行は返さない。
 * 価格は表示文字列から数字だけを拾う ("¥8,000" でも "8000" でも可)。
 */
function readMenuSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.MENU);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];

  const rows = sh.getRange(2, 1, last - 1, 6).getDisplayValues();
  const out = [];
  rows.forEach(r => {
    const name = String(r[0] || '').trim();
    if (!name) return;
    const active = String(r[4] || '').trim().toUpperCase();
    if (active === 'FALSE') return;
    const price = Number(String(r[3] || '').replace(/[^0-9.]/g, ''));
    if (!price) return;
    out.push({
      name: name,
      category: String(r[1] || '').trim(),
      persons: String(r[2] || '').trim(),
      price: price,
      note: String(r[5] || '').trim(),
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

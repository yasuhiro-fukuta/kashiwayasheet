/**
 * ============================================================
 *  Main.gs - エントリポイント (v2.10)
 * ============================================================
 *  ★v2.10 で処理順を変更した。
 *
 *    旧: iCal同期 → フォーム同期 → Lodgify取得 → 清掃ボード
 *    新: iCal同期 → Lodgify取得 → フォーム同期 → 清掃ボード
 *
 *    フォーム同期の中で LatestOptions の人数を Lodgify から補完する
 *    ため、Lodgify 取得が先に終わっている必要がある。
 *    旧順序のままだと、補完は常に「1回前のバッチで取った Lodgify」を
 *    見ることになり、当日入った予約の人数が1時間遅れていた。
 *
 *  Lodgify 取得と清掃ボード生成は個別に try/catch で囲む。
 *  どちらが失敗しても既存の予約同期・フォーム同期は成立させたい。
 *
 *  自動実行は毎時トリガー hourlySync の1本だけ。
 * ============================================================
 */

function runBatch() {
  const now = nowJst();
  const prev = getLastProcessedAt();
  dlog(`=== Batch start ===`);
  dlog(`now: ${fmtDateTime(now)}, prev: ${fmtDateTime(prev)}`);

  try {
    const disappeared = syncReservationsAndDetectDisappearance(now);

    // ── Lodgify 取得 (人数の権威データ + 直予約の唯一の経路) ──
    //  フォーム同期の人数補完より前に実行すること。
    //  失敗しても後続は続行する。
    try {
      const ldg = syncLodgifyBookings(now);
      dlog(`Lodgify: fetched=${ldg.fetched} (direct=${ldg.direct}) ` +
           `ins=${ldg.inserted} upd=${ldg.updated} del=${ldg.removed}`);
    } catch (e) {
      Logger.log(`Lodgify sync FAILED (continuing): ${e.stack || e}`);
    }

    const touched = syncOptions(now, prev, disappeared);
    dlog(`=== Reservation/Option sync done: ${touched.length} touched rows ===`);

    // ── 清掃予定表の生成 ────────────────────────────────────
    // Lodgify が失敗していても、iCal/フォーム/食事推定分で生成できる。
    try {
      const n = buildCleaningBoard();
      dlog(`CleaningBoard: ${n} rows`);
    } catch (e) {
      Logger.log(`CleaningBoard build FAILED (continuing): ${e.stack || e}`);
    }

    dlog(`=== Batch end ===`);
    setLastProcessedAt(now);
  } catch (e) {
    Logger.log(`Batch ERROR: ${e.stack || e}`);
    throw e;
  }
}

/**
 * 毎時トリガーから呼ばれるエントリポイント。
 * ・LockService で多重実行を防止 (手動実行と重なった場合など)
 * ・失敗時はオーナーにメール通知 (無人運用のため沈黙させない)
 */
function hourlySync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('hourlySync SKIPPED: another execution is running.');
    return;
  }
  try {
    runBatch();
  } catch (e) {
    Logger.log(`hourlySync ERROR: ${e.stack || e}`);
    notifyError('hourlySync', e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * エラー通知メール。
 * 同一エラーの連投を防ぐため、直近30分以内に同じ通知を送っていたら抑制する。
 */
function notifyError(context, err) {
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'LAST_ERROR_MAIL_AT';
    const lastAt = Number(props.getProperty(key) || 0);
    const nowMs = Date.now();
    if (nowMs - lastAt < 30 * 60 * 1000) {
      Logger.log('Error mail suppressed (sent recently).');
      return;
    }

    const to = Session.getEffectiveUser().getEmail();
    if (!to) return;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const body = [
      `柏屋 予約同期バッチでエラーが発生しました。`,
      ``,
      `発生時刻: ${fmtDateTime(new Date())}`,
      `処理    : ${context}`,
      `シート  : ${ss.getName()}`,
      `URL     : ${ss.getUrl()}`,
      ``,
      `--- エラー内容 ---`,
      String(err && err.stack ? err.stack : err),
    ].join('\n');

    MailApp.sendEmail(to, '[柏屋] 予約同期バッチ エラー', body);
    props.setProperty(key, String(nowMs));
  } catch (e) {
    Logger.log(`notifyError failed: ${e}`);
  }
}

function testFetchOnly() {
  const all = fetchAllReservations();
  Logger.log(`Total: ${all.length} reservations (after nightly expansion + dedup)`);
  all.slice(0, 10).forEach(r => {
    Logger.log(`- [${r.source}/${r.room}] ${fmtDate(r.checkin)}`);
  });
  return all.length;
}

function initialPopulate() {
  const now = nowJst();
  const latestSh = getSheet(CONFIG.SHEET.LATEST_RES);
  const prevSh = getSheet(CONFIG.SHEET.PREV_RES);
  const disSh = getSheet(CONFIG.SHEET.DISAPPEARED);

  if (latestSh.getLastRow() > 1) {
    throw new Error('LatestReservations is not empty. Clear data rows first.');
  }

  truncateSheet(prevSh);
  truncateSheet(disSh);

  const items = fetchAllReservations();
  const rows = items.map(i => itemToResRow(i, now));
  if (rows.length > 0) {
    latestSh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  Logger.log(`Populated ${rows.length} reservations.`);
  setLastProcessedAt(now);
}

/**
 * トリガーを登録する。
 *   hourlySync … 1時間おき。これが唯一の自動実行経路。
 */
function setupTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers
    .filter(t => t.getHandlerFunction() === 'hourlySync')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('hourlySync')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('Trigger set: hourlySync runs every hour.');
}

/**
 * 過去に登録した onOpenBatch トリガーを削除する (後片付け用)。
 */
function removeOnOpenBatchTrigger() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onOpenBatch') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  Logger.log(`Removed ${n} onOpenBatch trigger(s).`);
}

/**
 * 現在登録されているトリガーの一覧をログ出力 (確認用)
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers registered.');
    return;
  }
  triggers.forEach(t => {
    Logger.log(`- ${t.getHandlerFunction()} / ${t.getEventType()} / ${t.getTriggerSource()}`);
  });
}

function resetAll() {
  truncateSheet(getSheet(CONFIG.SHEET.LATEST_RES));
  truncateSheet(getSheet(CONFIG.SHEET.PREV_RES));
  truncateSheet(getSheet(CONFIG.SHEET.DISAPPEARED));
  truncateSheet(getSheet(CONFIG.SHEET.LATEST_OPT));
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.PROP.LAST_PROCESSED);
  Logger.log('All sheets cleared.');
  // 注意: LodgifyBookings は蓄積シートなので意図的に消していない。
  //       消す場合は手動で行うこと。
}

function dumpBookingVevent() {
  dumpVeventAt(0);
}

function dumpAirbnbVevent() {
  dumpVeventAt(2);
}

function dumpVeventAt(index) {
  const url = CONFIG.ICAL_SOURCES[index].url;
  const options = {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KashiwayaSync/1.0)',
      'Accept':     'text/calendar, text/plain, */*',
    },
  };
  const res = UrlFetchApp.fetch(url, options);
  const text = res.getContentText();
  const match = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  Logger.log(`Total VEVENTs: ${match.length}`);
  match.slice(0, 3).forEach((v, i) => {
    Logger.log(`\n--- VEVENT ${i + 1} ---\n${v}`);
  });
}

/**
 * LatestOptions に条件付き書式を設定 (手動1回実行)
 * 対象範囲: A2:L1000 (12列)
 * 優先度順:
 *   1. ほなみや転記済 (L列=12列目) が TRUE  → 灰色 (対応完了)
 *   2. 3日以下前 × 削除                     → 赤 (Lv4)
 *   3. 4日以上前 × 削除                     → 黄 (Lv2)
 *   4. 3日以下前 × active                   → オレンジ (Lv3)
 *   5. 4日以上前 × active                   → 薄黄 (Lv1)
 */
function setupConditionalFormatting() {
  const sh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const maxRow = 1000;
  const range = sh.getRange(2, 1, maxRow - 1, 12);

  sh.clearConditionalFormatRules();
  const rules = [];

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$L2=TRUE')
      .setBackground('#D9D9D9')
      .setRanges([range])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($B2="削除", $D2<>"", $D2-TODAY()<=3)')
      .setBackground('#FF7C80')
      .setRanges([range])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($B2="削除", $D2<>"", $D2-TODAY()>=4)')
      .setBackground('#FFE699')
      .setRanges([range])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($B2<>"削除", $D2<>"", $D2-TODAY()<=3, $D2-TODAY()>=0)')
      .setBackground('#F4B084')
      .setRanges([range])
      .build()
  );

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($B2<>"削除", $D2<>"", $D2-TODAY()>=4)')
      .setBackground('#FFF2CC')
      .setRanges([range])
      .build()
  );

  sh.setConditionalFormatRules(rules);
  Logger.log('Conditional formatting rules applied (12 cols).');
}

/**
 * カスタムメニューの追加 (ブラウザ版でスプレッドシートを開いた時に自動実行)
 * ※スマホアプリでは onOpen は発火しないため、このメニューは表示されない。
 *   スマホからの実行は不要にする方針 (毎時トリガーで自動化)。
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🏮 柏屋')
    .addItem('🔄 バッチ実行 (runBatch)',            'runBatch')
    .addItem('📥 iCal取得テスト (testFetchOnly)',   'testFetchOnly')
    .addSeparator()
    .addItem('✅ 反映後の自己診断 (selfTest)',       'selfTest')
    .addItem('🧹 清掃ボードだけ再生成',              'buildCleaningBoard')
    .addItem('🏨 Lodgify取得だけ実行',              'runLodgifySyncOnly')
    .addItem('👥 食事表の人数だけ補完',              'runGuestBackfillOnly')
    .addItem('📋 Check-In Form 未提出を一覧',        'listPendingCheckinForms')
    .addItem('🔍 Check-In Form 読み込み確認',        'dumpCheckinForm')
    .addItem('❓ E列が赤い理由を調べる',              'explainRedKeys')
    .addItem('🔍 Lodgify レスポンス確認',            'dumpLodgifyBookings')
    .addItem('🩺 直予約・人数の突合診断',            'diagnoseLodgifyMatch')
    .addSeparator()
    .addItem('🎨 条件付き書式を設定 (Options)',       'setupConditionalFormatting')
    .addItem('🎨 条件付き書式を設定 (清掃ボード)',    'setupCleaningFormatting')
    .addItem('⏰ 毎時トリガーを設定',                'setupTriggers')
    .addItem('📋 トリガー一覧を確認',                 'listTriggers')
    .addSeparator()
    .addSubMenu(
      ui.createMenu('⚠️ 初期化・開発用')
        .addItem('🗑 全シート＋処理日時をリセット',   'resetAll')
        .addItem('🆕 初回データ投入 (initialPopulate)', 'initialPopulate')
        .addItem('🔍 Booking iCal 中身表示',          'dumpBookingVevent')
        .addItem('🔍 Airbnb iCal 中身表示',           'dumpAirbnbVevent')
        .addItem('🧹 onOpenトリガーを削除',            'removeOnOpenBatchTrigger')
    )
    .addToUi();
}

/**
 * メニューから Lodgify 取得だけを実行する薄いラッパー。
 */
function runLodgifySyncOnly() {
  const r = syncLodgifyBookings(nowJst());
  Logger.log(`Lodgify: fetched=${r.fetched} (direct=${r.direct}) ` +
             `ins=${r.inserted} upd=${r.updated} del=${r.removed}`);
}

/**
 * メニューから 食事予約表の人数補完だけを実行する薄いラッパー。
 * Lodgify 取得を先に済ませておくこと。
 */
function runGuestBackfillOnly() {
  const r = backfillOptionGuests(getSheet(CONFIG.SHEET.LATEST_OPT));
  Logger.log(`人数補完: +${r.filled} (Lodgify ${r.byLodgify} / 食事推定 ${r.byMeal}) ` +
             `未解決 ${r.unresolved}`);
}

/**
 * ============================================================
 *  Diagnose.gs - 突合が合わないときの原因切り分け (v2.10)
 * ============================================================
 *  次のどちらかが起きたら、まずこれを実行してログを見る。
 *    ・清掃ボードの「人数ソース」に Lodgify が出ない
 *    ・直予約の客が清掃ボードに出てこない / 食事表の人数が空欄
 *
 *  どの段階で落ちているかを1回の実行で特定する。
 * ============================================================
 */

function diagnoseLodgifyMatch() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── 1. LodgifyBookings シートの状態 ───────────────────────
  const sh = ss.getSheetByName(CONFIG.SHEET.LODGIFY);
  if (!sh) {
    Logger.log(`!! シート "${CONFIG.SHEET.LODGIFY}" が存在しません。`);
    Logger.log('   → メニューの「🏨 Lodgify取得だけ実行」を先に実行してください。');
    return;
  }

  const last = sh.getLastRow();
  Logger.log(`[1] ${CONFIG.SHEET.LODGIFY}: データ行 ${last - 1} 行`);
  if (last <= 1) {
    Logger.log('!! 空です。syncLodgifyBookings が失敗しているか未実行です。');
    return;
  }

  const C = CONFIG.COL_LDG;
  const vals = sh.getRange(2, 1, last - 1, 19).getValues();

  const roomCount = {};
  let deleted = 0, noPeople = 0, noDate = 0;

  vals.forEach(row => {
    if (row[C.DELETED_FLAG - 1] === '削除') { deleted++; return; }
    const room = String(row[C.ROOM - 1] || '(空欄)').trim() || '(空欄)';
    roomCount[room] = (roomCount[room] || 0) + 1;
    if (!numOrZero(row[C.GUESTS - 1])) noPeople++;
    if (!fmtDate(row[C.CHECKIN - 1]) || !fmtDate(row[C.CHECKOUT - 1])) noDate++;
  });

  Logger.log(`[2] 論理削除 ${deleted} 行 / 有効 ${vals.length - deleted} 行`);
  Logger.log(`[3] 有効行の部屋分布: ${JSON.stringify(roomCount)}`);
  Logger.log(`    人数が0/空の行: ${noPeople} / 日付が読めない行: ${noDate}`);

  if (roomCount['(空欄)']) {
    Logger.log('!! 部屋が空欄の有効行があります。ROOM_MAP に room_type_id の追記が必要です。');
    Logger.log('   → 「🔍 Lodgify レスポンス確認」で生値を確認してください。');
  }

  // ── 4. 直予約の状況 ───────────────────────────────────────
  const bookings = loadLodgifyBookings();
  const direct = bookings.filter(b => b.isDirect);
  Logger.log(`[4] 突合に使える Lodgify 予約: ${bookings.length} 件 (うち直予約 ${direct.length} 件)`);
  direct.forEach(b => {
    Logger.log(`    直予約: ${b.room} ${b.checkin}→${b.checkout} ${b.name} ${b.people}名 src="${b.source}"`);
  });

  // ── 5. iCal の骨格と突合してみる ──────────────────────────
  const stays = readStaysFromReservations();
  Logger.log(`[5] LatestReservations から復元した滞在: ${stays.length} 件`);

  const covered = {};
  stays.forEach(s => {
    let d = s.checkin;
    let g = 0;
    while (d < s.checkout && g++ < 400) { covered[`${d}|${s.room}`] = true; d = addDaysStr(d, 1); }
  });

  const today = fmtDate(todayJst());
  const orphan = [];
  bookings.forEach(b => {
    let d = b.checkin;
    let g = 0;
    while (d < b.checkout && g++ < 400) {
      if (d >= today && !covered[`${d}|${b.room}`]) {
        orphan.push(`${d} ${b.room} ${b.name} ${b.people}名 ` +
                    `(${b.isDirect ? '直予約' : 'OTA'} src="${b.source}")`);
      }
      d = addDaysStr(d, 1);
    }
  });

  Logger.log(`[6] iCal に無い Lodgify の宿泊夜 (今日以降): ${orphan.length} 泊`);
  orphan.slice(0, 30).forEach(o => Logger.log('    ' + o));
  if (orphan.length) {
    Logger.log('    ※これらは mergeLodgifyStays() が清掃ボードに補完します。');
    Logger.log('    ※清掃ボードに出ていないなら buildCleaningBoard を再実行してください。');
  }

  let matched = 0;
  const misses = [];
  stays.forEach(s => {
    const hit = findLodgifyBooking(bookings, s.room, s.checkin);
    if (hit) { matched++; return; }
    if (misses.length < 10) {
      const other = bookings.find(b => b.checkin <= s.checkin && s.checkin < b.checkout);
      misses.push(`${s.checkin} ${s.room} → 不一致` +
        (other ? ` (同日に ${other.room} の予約あり: ${other.name} ${other.people}名)` : ' (同日の予約なし)'));
    }
  });

  Logger.log(`[7] Lodgify と突合できた iCal 滞在: ${matched} / ${stays.length}`);
  if (misses.length) {
    Logger.log('[8] 不一致サンプル:');
    misses.forEach(m => Logger.log('    ' + m));
    Logger.log('    ※「同日に別の部屋の予約あり」が並ぶ場合は ROOM_MAP の 1F/2F が逆です。');
    Logger.log('    ※「同日の予約なし」が並ぶ場合は Lodgify 側にその予約が存在しません。');
  }

  // ── 9. 食事予約表 (LatestOptions) の人数充足率 ─────────────
  diagnoseOptionGuests(bookings);
}

/**
 * LatestOptions の人数がどれだけ埋まっているかを報告する。
 * 「食事予約表の人数が取れない」の調査用。
 */
function diagnoseOptionGuests(bookings) {
  const list = bookings || loadLodgifyBookings();
  const sh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const last = sh.getLastRow();
  if (last <= 1) { Logger.log('[9] LatestOptions は空です。'); return; }

  const C = CONFIG.COL_OPT;
  const vals = sh.getRange(2, 1, last - 1, 11).getValues();

  let active = 0, filled = 0, byLodgify = 0, byMeal = 0;
  const unresolved = [];

  vals.forEach(row => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    if (!row[C.CHECKIN - 1]) return;
    active++;

    if (numOrZero(row[C.GUESTS - 1]) > 0) { filled++; return; }

    const d = fmtDate(row[C.CHECKIN - 1]);
    const room = String(row[C.ROOM - 1] || '').trim();
    const hit = findLodgifyBooking(list, room, d);
    if (hit && hit.people > 0) { byLodgify++; return; }
    if (estimatePeopleFromMeal(row[C.MEAL_SUMMARY - 1]) > 0) { byMeal++; return; }
    unresolved.push(`${d} ${room} ${row[C.GUEST_NAME - 1]}`);
  });

  Logger.log(`[9] LatestOptions 有効 ${active} 行: ` +
             `人数あり ${filled} / Lodgifyで埋まる ${byLodgify} / ` +
             `食事推定で埋まる ${byMeal} / 未解決 ${unresolved.length}`);
  if (unresolved.length) {
    Logger.log('    未解決 (CleaningOverride に手で書くか、過去予約で Lodgify 取得対象外):');
    unresolved.slice(0, 20).forEach(u => Logger.log('    ' + u));
  }
}

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

/**
 * 診断: 予約情報が「いつまで」取れているかを経路ごとに出す (v2.21)。
 *
 * 「予約が11月までしか入っていない」ときに、どこで止まっているかを
 * 一発で切り分けるためのもの。止まり方で原因が違う:
 *
 *   ・iCal の最終日が各ソースでほぼ同じ日
 *       → Booking.com / Airbnb の配信窓。こちらからは伸ばせない
 *   ・iCal の最終日が部屋ごとにバラバラ
 *       → 単にその先に予約が無いだけ (窓ではない)
 *   ・Lodgify には先の予約があるのに清掃ボードに出ていない
 *       → こちらのバグ。合流処理を見る
 *   ・Lodgify にも先の予約が無い
 *       → そもそも売っていない (OTA のカレンダーを開けていない等)
 *
 * 書き込みはしない。
 */
function diagnoseBookingHorizon() {
  const today = fmtDate(todayJst());
  Logger.log(`=== 予約の取得範囲 (今日 ${today}) ===`);

  const monthOf = (d) => String(d || '').substring(0, 7);
  const tally = (map, key) => { map[key] = (map[key] || 0) + 1; };
  const showMonths = (label, map) => {
    const keys = Object.keys(map).sort();
    if (!keys.length) { Logger.log(`  ${label}: (0件)`); return; }
    Logger.log(`  ${label}: ` + keys.map(k => `${k}:${map[k]}`).join('  '));
  };

  // ── 1. iCal (LatestReservations) ───────────────────────────
  Logger.log('\n--- ① iCal 由来 (LatestReservations) ---');
  const rSh = getSheet(CONFIG.SHEET.LATEST_RES);
  const rLast = rSh.getLastRow();
  const rVals = (rLast > 1) ? rSh.getRange(2, 1, rLast - 1, 8).getValues() : [];
  const RC = CONFIG.COL_RES;

  const icalMonths = {};
  const icalMaxBy  = {};   // "booking 1F" → 最終日
  rVals.forEach(row => {
    const d = fmtDate(row[RC.CHECKIN - 1]);
    if (!d) return;
    tally(icalMonths, monthOf(d));
    const k = `${String(row[RC.SOURCE - 1] || '?')} ${String(row[RC.ROOM - 1] || '?')}`;
    if (!icalMaxBy[k] || d > icalMaxBy[k]) icalMaxBy[k] = d;
  });
  Logger.log(`  泊数: ${rVals.length}`);
  showMonths('月別', icalMonths);
  Object.keys(icalMaxBy).sort().forEach(k =>
    Logger.log(`    ${k.padEnd(14)} 最終宿泊日 ${icalMaxBy[k]}`));

  const icalMax = Object.keys(icalMaxBy).reduce(
    (m, k) => (icalMaxBy[k] > m ? icalMaxBy[k] : m), '');
  if (icalMax) {
    Logger.log(`  → iCal は ${icalMax} まで (今日から ${daysBetweenStr(today, icalMax)} 日先)`);
  }

  // ── 2. Lodgify (LodgifyBookings の有効行) ──────────────────
  Logger.log('\n--- ② Lodgify 由来 (LodgifyBookings) ---');
  const bookings = loadLodgifyBookings();
  const ldgMonths = {};
  let ldgMaxDirect = '', ldgMaxOta = '';
  bookings.forEach(b => {
    if (!b.checkin) return;
    tally(ldgMonths, monthOf(b.checkin));
    if (b.isDirect) { if (b.checkin > ldgMaxDirect) ldgMaxDirect = b.checkin; }
    else            { if (b.checkin > ldgMaxOta)    ldgMaxOta    = b.checkin; }
  });
  Logger.log(`  有効な予約: ${bookings.length}`);
  showMonths('月別', ldgMonths);
  Logger.log(`    直予約 最終チェックイン ${ldgMaxDirect || '(なし)'}`);
  Logger.log(`    OTA   最終チェックイン ${ldgMaxOta || '(なし)'}`);
  const ldgMax = (ldgMaxDirect > ldgMaxOta) ? ldgMaxDirect : ldgMaxOta;
  if (ldgMax) {
    Logger.log(`  → Lodgify は ${ldgMax} まで (今日から ${daysBetweenStr(today, ldgMax)} 日先)`);
  }

  // ── 3. CleaningBoard に実際に出ている在室 ──────────────────
  Logger.log('\n--- ③ 清掃ボードに出ている在室 ---');
  const cSh = getSheet(CONFIG.SHEET.CLEANING);
  const CC = CONFIG.COL_CLEAN;
  const WS = CONFIG.CLEANING.WRITE_START_COL;
  const cLast = cSh.getLastRow();
  const cVals = (cLast > 1)
    ? cSh.getRange(2, WS, cLast - 1, CC.UPDATED_AT - WS + 1).getValues() : [];

  const boardMonths = {};
  let boardFirst = '', boardLast = '', occupiedMax = '';
  cVals.forEach(row => {
    const d = String(row[CC.DATE - WS] || '').trim() || fmtDate(row[CC.DATE - WS]);
    if (!d) return;
    if (!boardFirst || d < boardFirst) boardFirst = d;
    if (d > boardLast) boardLast = d;
    const state = String(row[CC.STATE - WS] || '').trim();
    if (state && state !== '空室') {
      tally(boardMonths, monthOf(d));
      if (d > occupiedMax) occupiedMax = d;
    }
  });
  Logger.log(`  行の範囲: ${boardFirst} 〜 ${boardLast} (${cVals.length}行)`);
  Logger.log(`  (CONFIG.CLEANING.DAYS_AHEAD = ${CONFIG.CLEANING.DAYS_AHEAD} 日先まで生成)`);
  showMonths('在室の月別', boardMonths);
  Logger.log(`  → 在室が入っている最終日 ${occupiedMax || '(なし)'}`);

  // ── 4. 判定 ───────────────────────────────────────────────
  Logger.log('\n=== 判定 ===');
  const icalKeys = Object.keys(icalMaxBy);
  if (icalKeys.length >= 2) {
    const ds = icalKeys.map(k => icalMaxBy[k]).sort();
    const spread = daysBetweenStr(ds[0], ds[ds.length - 1]);
    if (spread <= 3) {
      Logger.log(`・iCal の最終日がどのソースでも ${ds[0]} 前後 (差 ${spread} 日)。`);
      Logger.log('  → 配信側の窓で切られている可能性が高い。こちらからは伸ばせない。');
    } else {
      Logger.log(`・iCal の最終日はソースごとに ${ds[0]} 〜 ${ds[ds.length - 1]} とバラバラ。`);
      Logger.log('  → 窓ではなく「その先に予約が無い」だけ。');
    }
  }
  if (ldgMax && icalMax && ldgMax > icalMax) {
    Logger.log(`・Lodgify は iCal より先 (${ldgMax}) まで持っている。`);
    if (occupiedMax && occupiedMax >= ldgMax) {
      Logger.log('  → 清掃ボードにもそこまで出ている。合流は効いている。');
    } else {
      Logger.log(`  !! 清掃ボードは ${occupiedMax} までしか出ていない。合流処理の不具合の疑い。`);
    }
  }
  if (ldgMax && daysBetweenStr(today, ldgMax) < 270) {
    Logger.log(`・Lodgify 自体が ${daysBetweenStr(today, ldgMax)} 日先までしか予約を持っていない。`);
    Logger.log('  → 270日先まで欲しいなら、まず OTA 側のカレンダーがそこまで');
    Logger.log('    開いているか (販売期間の設定) を確認すること。');
    Logger.log('    予約が存在しなければ、取り込み側を直しても増えない。');
  }
}

/** 日付文字列 (yyyy-MM-dd) 同士の日数差 */
function daysBetweenStr(a, b) {
  const da = toDate(a), db = toDate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

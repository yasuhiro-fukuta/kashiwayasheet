/**
 * ============================================================
 *  ReservationSync.gs - 予約同期と消失検知
 * ============================================================
 *  疑似コード:
 *    BookingからIcal受信
 *    AirbnbからIcal受信
 *    truncate table 前回最新予約
 *    Insert into 前回最新予約 select * from 今回最新予約
 *    truncate table 今回最新予約
 *    Insert into 今回最新予約 select 宿泊日、部屋名 from 両Ical
 *    truncate table 消えた予約
 *    Insert into 消えた予約 select * from 前回最新予約 minus select * from 今回最新予約
 *
 *  ★ここは OTA の iCal だけを扱う。Lodgify 直予約は入ってこない。
 *    直予約の合流は CleaningBoard.gs の mergeLodgifyStays() が担当。
 * ============================================================
 */

/**
 * 予約同期を実行し、消えた予約リストを返す
 * @param {Date} [now] バッチ基準時刻 (省略時は nowJst())
 * @return {Array} DisappearedRes に書き込まれた行 (後続のキャンセル反映で使う)
 */
function syncReservationsAndDetectDisappearance(now) {
  const ts = now || nowJst();
  const latestSh = getSheet(CONFIG.SHEET.LATEST_RES);
  const prevSh   = getSheet(CONFIG.SHEET.PREV_RES);
  const disSh    = getSheet(CONFIG.SHEET.DISAPPEARED);

  // 1. PrevReservations ← LatestReservations (コピー)
  copyLatestToPrev(latestSh, prevSh);

  // 2. iCal取得 → LatestReservations に書き込み
  truncateSheet(latestSh);
  const items = fetchAllReservations();
  const rows = items.map(i => itemToResRow(i, ts));
  if (rows.length > 0) {
    latestSh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  dlog(`LatestReservations: ${rows.length} rows written.`);

  // 3. 消えた予約 = Prev - Latest
  const prevKeys = readReservationKeys(prevSh);
  const latestKeys = new Set(readReservationKeys(latestSh).map(k => keyStr(k)));

  const disappeared = prevKeys.filter(k => !latestKeys.has(keyStr(k)));

  truncateSheet(disSh);
  if (disappeared.length > 0) {
    const disRows = disappeared.map(k => [
      k.checkin, k.room, ts, k.reservationId || '', k.source || '', k.identifier || '',
    ]);
    disSh.getRange(2, 1, disRows.length, 6).setValues(disRows);
  }
  dlog(`DisappearedRes: ${disappeared.length} rows written.`);

  return disappeared;
}

/**
 * LatestReservations の内容を PrevReservations にコピー
 */
function copyLatestToPrev(latestSh, prevSh) {
  truncateSheet(prevSh);
  const lastRow = latestSh.getLastRow();
  if (lastRow <= 1) return;
  const lastCol = 8;  // Reservations は8列
  const vals = latestSh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  if (vals.length > 0) {
    prevSh.getRange(2, 1, vals.length, lastCol).setValues(vals);
  }
}

/**
 * 予約シートから {checkin, room, reservationId, source, identifier} の配列を取得
 */
function readReservationKeys(sh) {
  const last = sh.getLastRow();
  if (last <= 1) return [];
  const vals = sh.getRange(2, 1, last - 1, 8).getValues();
  const C = CONFIG.COL_RES;
  return vals
    .filter(r => r[C.CHECKIN - 1])
    .map(r => ({
      checkin:       r[C.CHECKIN - 1],
      room:          r[C.ROOM - 1],
      source:        r[C.SOURCE - 1],
      reservationId: r[C.RESERVATION_ID - 1],
      identifier:    r[C.IDENTIFIER - 1],
    }));
}

/**
 * キー文字列化 (ユニーク判定用)
 */
function keyStr(k) {
  return `${fmtDate(k.checkin)}|${k.room}`;
}

/**
 * iCalアイテムをLatestReservations行に変換
 */
function itemToResRow(item, now) {
  const C = CONFIG.COL_RES;
  const row = new Array(8).fill('');
  row[C.CHECKIN - 1]        = item.checkin;
  row[C.ROOM - 1]           = item.room;
  row[C.SOURCE - 1]         = item.source;
  row[C.RESERVATION_ID - 1] = item.reservationId;
  row[C.NIGHT_ID - 1]       = 1;
  row[C.IDENTIFIER - 1]     = item.identifier || '';
  row[C.FETCHED_AT - 1]     = now;
  row[C.NOTE - 1]           = '';
  return row;
}

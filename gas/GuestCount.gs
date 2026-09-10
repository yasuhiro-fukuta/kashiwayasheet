/**
 * ============================================================
 *  GuestCount.gs - 人数解決の共通ロジック (v2.10 新規)
 * ============================================================
 *  「人数が取れない」不具合の対策として、人数の解決処理を
 *  1か所にまとめた。以前は CleaningBoard.gs と Diagnose.gs に
 *  似て非なる突合コードが散らばっており、清掃ボードには人数が
 *  出るのに食事予約表(LatestOptions)は空欄、という食い違いが
 *  起きていた。
 *
 *  人数の優先順位 (先に決まったものを採用):
 *    1. 手動      CleaningOverride
 *    2. Lodgify   API (唯一の権威データ)
 *    3. フォーム   LatestOptions G列 (旧フォームのみ設問あり)
 *    4. 食事推定   食事サマリの「N人前」の最大値
 *    5. 不明      空欄 + 備考に警告
 *
 *  ★現行の Google フォームには人数設問が無い。
 *    実データでは有効な LatestOptions 44行のうち 23行が人数空欄で、
 *    そのうち 21行は Lodgify から埋められた。
 *    残り2行は宿泊済みで Lodgify の取得対象から外れた過去予約。
 * ============================================================
 */

/**
 * LodgifyBookings シートから有効な予約を読み込む。
 * 論理削除フラグが立っている行と、部屋・日付が解決できない行は除く。
 *
 * @return {Array<Object>} {bookingId, room, checkin, checkout, people,
 *                          name, source, isDirect} の配列
 */
function loadLodgifyBookings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CONFIG.SHEET.LODGIFY);
  if (!sh) {
    dlog('LodgifyBookings sheet not found.');
    return [];
  }

  const last = sh.getLastRow();
  if (last <= 1) return [];

  const C = CONFIG.COL_LDG;
  const vals = sh.getRange(2, 1, last - 1, 19).getValues();

  const out = [];
  vals.forEach(row => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    const room = String(row[C.ROOM - 1] || '').trim();
    const ci = fmtDate(row[C.CHECKIN - 1]);
    const co = fmtDate(row[C.CHECKOUT - 1]);
    if (!room || !ci || !co) return;

    const source = String(row[C.SOURCE - 1] || '').trim();
    out.push({
      bookingId: String(row[C.BOOKING_ID - 1] || '').trim(),
      room:      room,
      checkin:   ci,
      checkout:  co,
      people:    numOrZero(row[C.GUESTS - 1]),
      name:      String(row[C.GUEST_NAME - 1] || '').trim(),
      source:    source,
      isDirect:  isDirectLodgifySource(source),
    });
  });

  return out;
}

/**
 * Lodgify の source 文字列が「直予約」かどうかを判定する。
 *
 * 実データでは
 *   OTA 経由 … "5326808288|6222108251" のような数字とパイプの組
 *   直予約   … "yasuo.lodgify.com" (自社予約ページのドメイン)
 * となっていた。空文字も直予約 (管理画面での手入力) 扱いにする。
 *
 * CONFIG.LODGIFY.DIRECT_SOURCE_PATTERNS で追加パターンを足せる。
 */
function isDirectLodgifySource(source) {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return true;                       // 手入力予約
  if (/^[\d|\s-]+$/.test(s)) return false;   // OTA の予約番号組
  const pats = CONFIG.LODGIFY.DIRECT_SOURCE_PATTERNS || [];
  for (let i = 0; i < pats.length; i++) {
    if (s.indexOf(String(pats[i]).toLowerCase()) >= 0) return true;
  }
  return false;
}

/**
 * 部屋と宿泊日から、その夜に該当する Lodgify 予約を1件選ぶ。
 *
 * 以前は Array.find() で「最初に見つかったもの」を採っていたため、
 * 同じ部屋で期間が重なる予約が複数あると (直予約と OTA が重なった、
 * 取得タイミングの違いで古い予約が残っていた等) 、
 * どれが選ばれるかが行順まかせになっていた。
 *
 * 優先順位:
 *   1. チェックイン日が完全一致するもの
 *   2. 期間が重なるもののうち、チェックインが最も遅いもの (直近の予約)
 * 同点なら人数が入っている方を優先する。
 *
 * @param {Array<Object>} bookings loadLodgifyBookings() の戻り値
 * @param {string} room    '1F' | '2F'
 * @param {string} dateStr 'yyyy-MM-dd' (その夜)
 * @return {Object|null}
 */
function findLodgifyBooking(bookings, room, dateStr) {
  if (!room || !dateStr) return null;

  const hits = bookings.filter(b =>
    b.room === room && b.checkin <= dateStr && dateStr < b.checkout
  );
  if (!hits.length) return null;

  hits.sort((a, b) => {
    const aExact = (a.checkin === dateStr) ? 1 : 0;
    const bExact = (b.checkin === dateStr) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    if (a.checkin !== b.checkin) return (a.checkin < b.checkin) ? 1 : -1;
    return (b.people > 0 ? 1 : 0) - (a.people > 0 ? 1 : 0);
  });

  return hits[0];
}

/**
 * 食事サマリから人数を推定する。
 * "Chicken Hot Pot(2人前), Ochazuke Breakfast(4人前)" のような文字列から
 * 「N人前」「N人用」を全部拾い、その最大値を返す。
 *
 * ★全角数字対応 (v2.10)。
 *   実データに "Chicken Hot Pot(１人前)" があり、
 *   半角前提の正規表現がマッチせず 0 を返していた。
 *
 * あくまで推定。1名で2人前を注文するケースがあるため過大評価しうる。
 * 人数ソース列に「食事推定」と出るので目視確認できる。
 *
 * @return {number} 推定人数。取れなければ 0
 */
function estimatePeopleFromMeal(mealSummary) {
  const s = toHalfWidth(mealSummary);
  const matches = s.match(/(\d+(?:\.\d+)?)\s*人(?:前|用)/g);
  if (!matches || !matches.length) return 0;

  let max = 0;
  matches.forEach(m => {
    const n = parseFloat(m);
    if (n > max) max = n;
  });
  return Math.ceil(max);
}

/**
 * LatestOptions (食事予約表) の人数列を埋める。
 *
 * ★これが「食事予約表の人数が取れないことがある」への対策。
 *   現行フォームには人数設問が無いため G列は空のまま溜まっていく。
 *   バッチのたびに Lodgify → 食事推定 の順で空欄だけを埋める。
 *
 * 方針:
 *   ・すでに値が入っている行には触らない (手入力・旧フォームの値を尊重)
 *   ・論理削除済みの行は対象外
 *   ・書き込みは G列のみ。他の列や M列の曜日数式には一切触れない
 *
 * @param {Sheet} optSh LatestOptions シート
 * @return {{filled:number, byLodgify:number, byMeal:number, unresolved:number}}
 */
function backfillOptionGuests(optSh) {
  const result = { filled: 0, byLodgify: 0, byMeal: 0, unresolved: 0 };

  const last = optSh.getLastRow();
  if (last <= 1) return result;

  const C = CONFIG.COL_OPT;
  const vals = optSh.getRange(2, 1, last - 1, 11).getValues();
  const bookings = loadLodgifyBookings();

  // G列だけをまとめて読み書きする (1列 setValues で API 呼び出しを1回に)
  const guestCol = vals.map(row => [row[C.GUESTS - 1]]);
  let dirty = false;

  vals.forEach((row, idx) => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;

    const cur = row[C.GUESTS - 1];
    if (cur !== '' && cur !== null && cur !== undefined && numOrZero(cur) > 0) return;

    const d = fmtDate(row[C.CHECKIN - 1]);
    const room = String(row[C.ROOM - 1] || '').trim();
    if (!d || !room) return;

    const hit = findLodgifyBooking(bookings, room, d);
    if (hit && hit.people > 0) {
      guestCol[idx][0] = hit.people;
      result.filled++; result.byLodgify++; dirty = true;
      return;
    }

    const est = estimatePeopleFromMeal(row[C.MEAL_SUMMARY - 1]);
    if (est > 0) {
      guestCol[idx][0] = est;
      result.filled++; result.byMeal++; dirty = true;
      return;
    }

    result.unresolved++;
    dlog(`人数を解決できず: ${d} ${room} ${row[C.GUEST_NAME - 1]}`);
  });

  if (dirty) {
    optSh.getRange(2, C.GUESTS, guestCol.length, 1).setValues(guestCol);
  }

  dlog(`LatestOptions 人数補完: +${result.filled} ` +
       `(Lodgify ${result.byLodgify} / 食事推定 ${result.byMeal}) ` +
       `未解決 ${result.unresolved}`);
  return result;
}

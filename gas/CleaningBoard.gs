/**
 * ============================================================
 *  CleaningBoard.gs - 清掃予定表の生成 (v2.10)
 * ============================================================
 *  「今日、何階に何人来るのか」を清掃スタッフが1画面で見られる
 *  日付 × 部屋 の表を CleaningBoard シートに生成する。
 *  AppSheet はこのシートをデータソースにする。
 *
 *  ★v2.10 の最重要修正: Lodgify 直予約が表に出ない問題
 *
 *    在室の骨格を LatestReservations (= Booking.com / Airbnb の iCal)
 *    だけから作っていた。Lodgify の自社予約ページや管理画面から入った
 *    直予約は、どの OTA の iCal にも現れない。
 *    結果、実際には客がいる部屋が「空室」と表示されていた。
 *
 *    実データでの確認 (2026-09-02 時点):
 *      2026-11-24 2F  Gloria Cereda      2名  → 表示は「OUT→空室」
 *      2026-11-25 2F  Michael Conor Cook 2名  → 表示は「空室」
 *      2027-03-31 1F  Amanda McLaughlin  3名  → 表示は「空室」
 *    いずれも source = yasuo.lodgify.com の直予約。
 *
 *    対策: iCal が押さえていない夜に限って Lodgify 予約を骨格に合流させる
 *          (mergeLodgifyStays)。
 *          直予約でも Booking.com 側が "CLOSED" ブロックを出していれば
 *          iCal に夜が存在するので、その場合は従来どおり iCal の行に
 *          人数と氏名だけを載せる。二重計上はしない。
 *
 *  データの流れ:
 *    LatestReservations  … 在室の骨格 (1泊1行)
 *      ↓ 連続する泊を「滞在」にまとめる
 *    LodgifyBookings     … 人数の権威データ + iCal に無い直予約の補完
 *    LatestOptions       … 人数(旧フォーム分) / 宿泊者名 / 食事サマリ
 *    CleaningOverride    … 手動上書き。最優先
 *      ↓
 *    CleaningBoard       … 毎回全書き換え
 *
 *  重要: CleaningBoard の E列以降は毎バッチ全消しして書き直す。
 *        人が直接書き込んでも消えるので、手入力は必ず A〜D列か
 *        CleaningOverride 側に行うこと。
 * ============================================================
 */

/**
 * 清掃予定表を生成する。runBatch から呼ばれる。
 * @return {number} 生成した行数
 */
function buildCleaningBoard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const bookings = loadLodgifyBookings();

  const stays = readStaysFromReservations();
  dlog(`CleaningBoard: ${stays.length} stays from LatestReservations`);

  const added = mergeLodgifyStays(stays, bookings);
  dlog(`CleaningBoard: +${added} stays from Lodgify (iCal に無い予約)`);

  applyLodgifyPeople(stays, bookings);
  applyOptionsInfo(stays);
  applyOverride(stays);
  applyCheckinFormStatus(stays);   // 宿泊者名簿フォームの提出状況

  const rows = renderCleaningRows(stays);
  writeCleaningBoard(ss, rows);

  // Check-In Form 未提出の警告 (書式のみ)。
  // 失敗しても本体の書き込みは確定させたいので握りつぶす。
  try {
    const n = applyCheckinFormAlerts(stays, rows);
    dlog(`Check-In Form 未提出の警告: ${n} 行`);
  } catch (e) {
    Logger.log(`Check-In Form 警告の適用に失敗 (処理は続行): ${e.stack || e}`);
  }

  dlog(`CleaningBoard: ${rows.length} rows written`);
  return rows.length;
}

// ============================================================
//  1. LatestReservations → 滞在単位
// ============================================================

/**
 * LatestReservations (1泊1行) を読み、
 * 予約ID + 部屋 が同じで日付が連続しているものを1滞在にまとめる。
 *
 * Booking.com は連泊でも VEVENT が1泊ずつ分裂するが、
 * 同一予約なら予約IDが同じなのでここで再結合できる。
 *
 * @return {Array<Object>} stay オブジェクトの配列
 */
function readStaysFromReservations() {
  const sh = getSheet(CONFIG.SHEET.LATEST_RES);
  const last = sh.getLastRow();
  if (last <= 1) return [];

  const C = CONFIG.COL_RES;
  const vals = sh.getRange(2, 1, last - 1, 8).getValues();

  const nights = [];
  vals.forEach(row => {
    const d = fmtDate(row[C.CHECKIN - 1]);
    const room = String(row[C.ROOM - 1] || '').trim();
    if (!d || !room) return;
    nights.push({
      date:       d,
      room:       room,
      source:     String(row[C.SOURCE - 1] || '').trim(),
      resId:      String(row[C.RESERVATION_ID - 1] || '').trim(),
      identifier: String(row[C.IDENTIFIER - 1] || '').trim(),
      note:       String(row[C.NOTE - 1] || '').trim(),
    });
  });

  // 予約ID + 部屋 でグルーピング
  const groups = {};
  nights.forEach(n => {
    const k = `${n.room}|${n.resId || 'noid_' + n.date}`;
    if (!groups[k]) groups[k] = [];
    groups[k].push(n);
  });

  const stays = [];
  Object.keys(groups).forEach(k => {
    const list = groups[k].sort((a, b) => (a.date < b.date ? -1 : 1));
    let cur = null;

    list.forEach(n => {
      if (cur && addDaysStr(cur.lastNight, 1) === n.date) {
        cur.lastNight = n.date;
        cur.nights++;
        return;
      }
      if (cur) stays.push(cur);
      cur = newStay({
        room:       n.room,
        resId:      n.resId,
        source:     n.source,
        identifier: n.identifier,
        checkin:    n.date,
        origin:     'iCal',
        notes:      n.note ? [n.note] : [],
      });
    });
    if (cur) stays.push(cur);
  });

  // チェックアウト = 最終泊の翌日
  stays.forEach(s => { s.checkout = addDaysStr(s.lastNight, 1); });
  return stays;
}

/**
 * stay オブジェクトの生成 (既定値をここに集約)
 */
function newStay(o) {
  return {
    room:       o.room,
    resId:      o.resId || '',
    source:     o.source || '',
    identifier: o.identifier || '',
    checkin:    o.checkin,
    lastNight:  o.lastNight || o.checkin,
    checkout:   o.checkout || '',
    nights:     o.nights || 1,
    people:     o.people || 0,
    peopleSrc:  o.peopleSrc || '',
    name:       o.name || '',
    meal:       '',
    origin:     o.origin || 'iCal',
    notes:      o.notes || [],
    // Check-In Form (宿泊者名簿) の記入があったか。
    //   true=提出済み / false=未提出 / null=判定不能
    // applyCheckinFormStatus() が設定する。
    // ★食事フォーム (LatestOptions) とは別物なので混同しないこと。
    formDone:   null,
  };
}

// ============================================================
//  2. iCal に無い Lodgify 予約 (= 直予約) を骨格に合流させる
// ============================================================

/**
 * Lodgify にはあるが LatestReservations には無い「夜」を拾い、
 * 連続する夜をまとめて滞在として stays に追加する。
 *
 * ここが v2.10 の主目的。Lodgify 直予約はどの OTA の iCal にも
 * 出てこないため、この合流が無いと清掃ボード上は空室のままになる。
 *
 * 二重計上を避けるため、判定は「夜」単位で行う:
 *   ・iCal がすでに押さえている (日付, 部屋) はスキップ
 *     → 従来どおり iCal 側の行に applyLodgifyPeople が人数を載せる
 *   ・押さえていない夜だけを集め、連続していれば1滞在にまとめる
 *
 * 直予約でなくても (OTA 予約なのに iCal 取得が失敗していた等)、
 * 穴が空いていれば同じ理屈で埋まる。取りこぼしよりは表示過多の方が
 * 清掃現場では安全なので、この方針でよい。
 *
 * @param {Array<Object>} stays    readStaysFromReservations() の結果 (破壊的に追加)
 * @param {Array<Object>} bookings loadLodgifyBookings() の結果
 * @return {number} 追加した滞在数
 */
function mergeLodgifyStays(stays, bookings) {
  if (!bookings || !bookings.length) return 0;

  const today = fmtDate(todayJst());

  // iCal が押さえている夜の集合
  const covered = {};
  stays.forEach(s => {
    let d = s.checkin;
    while (d < s.checkout) {
      covered[`${d}|${s.room}`] = true;
      d = addDaysStr(d, 1);
    }
  });

  let added = 0;

  bookings.forEach(b => {
    // 未カバーの夜を洗い出す
    const gaps = [];
    let d = b.checkin;
    let guard = 0;
    while (d < b.checkout && guard++ < 400) {
      if (!covered[`${d}|${b.room}`]) gaps.push(d);
      d = addDaysStr(d, 1);
    }
    if (!gaps.length) return;

    // 連続する夜を1滞在にまとめる
    let cur = null;
    const flush = () => {
      if (!cur) return;
      cur.checkout = addDaysStr(cur.lastNight, 1);
      stays.push(cur);
      added++;
      cur = null;
    };

    gaps.forEach(ds => {
      if (cur && addDaysStr(cur.lastNight, 1) === ds) {
        cur.lastNight = ds;
        cur.nights++;
        return;
      }
      flush();
      // 備考の出し分け:
      //   直予約        … 常に「直予約」と明示する (iCal に出ないのが正常)
      //   過去のOTA予約 … 無印。iCal は過去分を配信しないので欠けて当然
      //   未来のOTA予約 … 「iCal未掲載」。iCal 取得の取りこぼしが疑われる
      let note = '';
      if (b.isDirect)      note = '直予約';
      else if (ds >= today) note = '⚠iCal未掲載 (取得もれの可能性)';

      cur = newStay({
        room:      b.room,
        resId:     `lodgify_${b.bookingId}`,
        source:    b.isDirect ? '直予約' : (b.source || 'Lodgify'),
        checkin:   ds,
        people:    b.people || 0,
        peopleSrc: b.people > 0 ? 'Lodgify' : '',
        name:      b.name || '',
        origin:    'Lodgify',
        notes:     note ? [note] : [],
      });
      // 元予約の期間も持たせておく (人数突合の取りこぼし防止)
      cur.lodgifyCheckin  = b.checkin;
      cur.lodgifyCheckout = b.checkout;
      cur.lodgifySource   = b.source || '';
    });
    flush();

    dlog(`Lodgify から補完: ${b.room} ${gaps[0]}〜 ${b.name} ${b.people}名 ` +
         `(${b.isDirect ? '直予約' : 'OTA'} src=${b.source})`);
  });

  return added;
}

// ============================================================
//  3. Lodgify から人数を当てる
// ============================================================

/**
 * 部屋一致 かつ 期間が重なる Lodgify 予約から人数・氏名を当てる。
 *
 * v2.10: 突合を findLodgifyBooking() に統一した。
 *   以前は Array.find() で最初の1件を採っていたため、期間が重なる
 *   予約が複数あると行順まかせで別人の人数が載ることがあった。
 *
 * @param {Array<Object>} stays
 * @param {Array<Object>} [bookings] 省略時はシートから読む
 */
function applyLodgifyPeople(stays, bookings) {
  const list = bookings || loadLodgifyBookings();
  if (!list.length) { dlog('Lodgify booking がありません。人数突合をスキップ。'); return; }

  stays.forEach(s => {
    if (s.origin === 'Lodgify') return;   // すでに Lodgify 由来

    const hit = findLodgifyBooking(list, s.room, s.checkin);
    if (!hit) return;

    if (hit.people > 0) {
      s.people = hit.people;
      s.peopleSrc = 'Lodgify';
    }
    if (hit.name && !s.name) s.name = hit.name;
    if (hit.source) s.lodgifySource = hit.source;
    if (hit.isDirect && s.notes.indexOf('直予約') < 0) s.notes.push('直予約');
  });
}

// ============================================================
//  4. LatestOptions から人数 / 氏名 / 食事を補完
// ============================================================

/**
 * LatestOptions を (宿泊日, 部屋) で突合する。
 * 同じキーに複数行ある場合はフォーム送信日時が最も新しい行を採用。
 * 論理削除フラグが立っている行は無視する。
 *
 * v2.10: 完全一致で拾えなかった滞在は、滞在期間内のどこかの日付で
 *   出されたフォームも拾うようにした。連泊のうち中日の日付で
 *   フォームを出す客がいるため、以前は食事が丸ごと落ちていた。
 */
function applyOptionsInfo(stays) {
  const sh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const last = sh.getLastRow();
  if (last <= 1) return;

  const C = CONFIG.COL_OPT;
  const vals = sh.getRange(2, 1, last - 1, 11).getValues();

  const latest = {};
  vals.forEach(row => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    const d = fmtDate(row[C.CHECKIN - 1]);
    const room = String(row[C.ROOM - 1] || '').trim();
    if (!d || !room) return;

    const key = `${d}|${room}`;
    const ts = toDate(row[C.FORM_TS - 1]);
    const tsMs = (ts && !isNaN(ts.getTime())) ? ts.getTime() : 0;

    if (!latest[key] || tsMs >= latest[key].tsMs) {
      latest[key] = {
        tsMs:   tsMs,
        date:   d,
        room:   room,
        name:   String(row[C.GUEST_NAME - 1] || '').trim(),
        people: numOrZero(row[C.GUESTS - 1]),
        meal:   String(row[C.MEAL_SUMMARY - 1] || '').trim(),
        opt:    String(row[C.OPT_SUMMARY - 1] || '').trim(),
        other:  String(row[C.OTHER_REQ - 1] || '').trim(),
      };
    }
  });

  stays.forEach(s => {
    let hit = latest[`${s.checkin}|${s.room}`];

    // 連泊の中日でフォームが出されている場合の救済
    if (!hit) {
      let d = addDaysStr(s.checkin, 1);
      while (d < s.checkout) {
        if (latest[`${d}|${s.room}`]) { hit = latest[`${d}|${s.room}`]; break; }
        d = addDaysStr(d, 1);
      }
    }
    if (!hit) return;

    if (hit.name && !s.name) s.name = hit.name;
    if (hit.meal) s.meal = hit.meal;
    if (hit.opt)   s.notes.push(hit.opt);
    if (hit.other) s.notes.push(hit.other);

    // Lodgify で埋まっていなければフォームの人数を使う
    if (!s.people && hit.people > 0) {
      s.people = hit.people;
      s.peopleSrc = 'フォーム';
    }
    // それでも駄目なら食事サマリから推定する
    if (!s.people && hit.meal) {
      const est = estimatePeopleFromMeal(hit.meal);
      if (est > 0) {
        s.people = est;
        s.peopleSrc = '食事推定';
      }
    }
  });
}

// ============================================================
//  5. 手動上書き (最優先)
// ============================================================

/**
 * CleaningOverride シートの内容を最優先で適用する。
 * このシートは人が手で書く。GAS は読むだけで書き換えない。
 *
 * キーは (宿泊日=チェックイン日, 部屋)。
 * 人数が Lodgify でもフォームでも埋まらない予約は、
 * ここに1行足せば CleaningBoard に反映される。
 */
function applyOverride(stays) {
  const sh = ensureOverrideSheet();
  const last = sh.getLastRow();
  if (last <= 1) return;

  const C = CONFIG.COL_OVR;
  const vals = sh.getRange(2, 1, last - 1, 5).getValues();

  const map = {};
  vals.forEach(row => {
    const d = fmtDate(row[C.CHECKIN - 1]);
    const room = String(row[C.ROOM - 1] || '').trim();
    if (!d || !room) return;
    map[`${d}|${room}`] = {
      people: numOrZero(row[C.GUESTS - 1]),
      name:   String(row[C.GUEST_NAME - 1] || '').trim(),
      memo:   String(row[C.MEMO - 1] || '').trim(),
    };
  });

  stays.forEach(s => {
    const hit = map[`${s.checkin}|${s.room}`];
    if (!hit) return;
    if (hit.people > 0) {
      s.people = hit.people;
      s.peopleSrc = '手動';
    }
    if (hit.name) s.name = hit.name;
    if (hit.memo) s.notes.push(hit.memo);
  });
}

/**
 * CleaningOverride シートを用意する (無ければヘッダー付きで作成)
 */
function ensureOverrideSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET.CLEAN_OVERRIDE);
  if (sh) return sh;

  sh = ss.insertSheet(CONFIG.SHEET.CLEAN_OVERRIDE);
  const header = ['宿泊日(チェックイン)', '部屋', '人数', '宿泊者名', 'メモ'];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#FFF2CC');
  sh.setFrozenRows(1);
  sh.getRange(2, 1, 1000, 1).setNumberFormat('yyyy-mm-dd');
  return sh;
}

// ============================================================
//  6. 日付 × 部屋 に展開
// ============================================================

/**
 * 滞在の配列を、日付 × 部屋 の行に展開する。
 *
 * GAS が判定するのは「状態」だけ:
 *   OUT→IN   退室と到着が同日
 *   OUT→空室 退室のみ。次の到着日は「次回IN日」に併記
 *   連泊     在室中の中日
 *   IN       到着のみ
 *   空室     誰もいない
 *
 * 実際に誰がいつ何をするかは A〜D列 (手動列) に人が手で書く。
 * GAS はそちらには一切触らない。
 *
 * @return {Array<Array>} E列以降に書き込む2次元配列
 */
function renderCleaningRows(stays) {
  const CL = CONFIG.CLEANING;
  const C = CONFIG.COL_CLEAN;
  const WS = CL.WRITE_START_COL;          // 書き込み開始列 (E=5)
  const WIDTH = C.UPDATED_AT - WS + 1;    // 書き込む列数
  const now = nowJst();
  const today = fmtDate(todayJst());
  const endDs = addDaysStr(today, CL.DAYS_AHEAD);
  const rows = [];

  // 日付×部屋で滞在を引けるように索引化する。
  // 以前は毎行 stays.filter() を3回まわしており、
  // 滞在数×日数 の総当たりになっていた。
  const byArrive = {}, byDepart = {}, byStay = {};
  const push = (m, k, v) => { (m[k] = m[k] || []).push(v); };
  stays.forEach(s => {
    push(byArrive, `${s.checkin}|${s.room}`, s);
    push(byDepart, `${s.checkout}|${s.room}`, s);
    let d = s.checkin;
    let guard = 0;
    while (d < s.checkout && guard++ < 400) {
      push(byStay, `${d}|${s.room}`, s);
      d = addDaysStr(d, 1);
    }
  });

  // 部屋ごとの到着日一覧 (次回IN日の算出用)
  const arrivalsByRoom = {};
  CL.ROOMS.forEach(r => {
    arrivalsByRoom[r] = stays.filter(s => s.room === r)
      .map(s => s.checkin).sort();
  });

  // 開始日は固定。ここが動くと A〜D列の手動列がずれる。
  //  guard は暴走よけの安全弁。START_DATE は固定で endDs は毎日進むため、
  //  年が経つほど必要な回数は増える。DAYS_AHEAD を伸ばしたときに
  //  黙って途中で打ち切られないよう、十分大きくとってある。
  let ds = CL.START_DATE;
  let guard = 0;

  while (ds <= endDs && guard++ < 20000) {
    const wd = weekdayJa(isoWeekday(ds));
    const dateStr = ds;

    CL.ROOMS.forEach(room => {
      const k = `${dateStr}|${room}`;
      const arriving  = byArrive[k] || [];
      const departing = byDepart[k] || [];
      const staying   = byStay[k]   || [];

      let state;
      if (departing.length && arriving.length)     state = 'OUT→IN';
      else if (departing.length)                   state = 'OUT→空室';
      else if (staying.length && !arriving.length) state = '連泊';
      else if (arriving.length)                    state = 'IN';
      else                                         state = '空室';

      // 退室のみの日は、次にその部屋へ入る滞在の日付を併記する
      let nextInDate = '';
      if (state === 'OUT→空室') {
        const next = arrivalsByRoom[room].find(d => d > dateStr);
        if (next) nextInDate = next;
      }

      // 人数・氏名などは「その夜の在室者」を出す
      const tonight = staying[0] || null;
      const notes = [];

      let guests = '', guestsSrc = '', guestName = '', source = '', nights = '', meal = '';
      if (tonight) {
        guests    = tonight.people || '';
        guestsSrc = tonight.peopleSrc || '不明';
        guestName = tonight.name || '(氏名未取得)';
        source    = tonight.lodgifySource || tonight.source || '';
        nights    = tonight.nights || '';
        meal      = tonight.meal || '';
        if (tonight.notes) tonight.notes.forEach(n => { if (n) notes.push(n); });
        if (!tonight.people) notes.push('⚠人数不明 → CleaningOverride に記入');
      }
      if (staying.length > 1) notes.unshift('⚠同室に複数予約');

      const row = new Array(WIDTH).fill('');
      row[C.KEY - WS]          = `${dateStr}_${room}`;
      row[C.GUESTS - WS]       = guests;
      row[C.STATE - WS]        = state;
      row[C.DATE - WS]         = dateStr;
      row[C.WEEKDAY - WS]      = wd;
      row[C.ROOM - WS]         = room;
      row[C.GUESTS_SRC - WS]   = guestsSrc;
      row[C.GUEST_NAME - WS]   = guestName;
      row[C.SOURCE - WS]       = source;
      row[C.CHECKIN_IN - WS]   = arriving.map(s => s.name || '(未取得)').join(' / ');
      row[C.CHECKOUT_OUT - WS] = departing.map(s => s.name || '(未取得)').join(' / ');
      row[C.NEXT_IN - WS]      = nextInDate;
      row[C.NIGHTS - WS]       = nights;
      row[C.MEAL - WS]         = meal;
      row[C.NOTE - WS]         = notes.join(' / ');
      row[C.UPDATED_AT - WS]   = now;

      rows.push(row);
    });

    ds = addDaysStr(ds, 1);
  }

  return rows;
}

/**
 * CleaningBoard に書き込む。
 *
 * ★A〜D列 (手動列) には一切触らない。
 *   clearContent も setValues も E列以降だけを対象にする。
 *   truncateSheet はシート全幅を消してしまうのでここでは使わない。
 */
function writeCleaningBoard(ss, rows) {
  const C = CONFIG.COL_CLEAN;
  const WS = CONFIG.CLEANING.WRITE_START_COL;
  const WIDTH = C.UPDATED_AT - WS + 1;
  const sh = ensureCleaningSheet();

  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, WS, last - 1, WIDTH).clearContent();
  }
  if (!rows.length) return;

  sh.getRange(2, WS, rows.length, WIDTH).setValues(rows);
}

function ensureCleaningSheet() {
  const C = CONFIG.COL_CLEAN;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET.CLEANING);
  if (sh) return sh;

  sh = ss.insertSheet(CONFIG.SHEET.CLEANING);
  // A〜D列は人が使う領域。見出しだけ置いて以降は触らない。
  const header = [
    '昼担当(手動)', '清掃(手動)', 'セット人数(手動)', '夜担当(手動)',
    'キー', 'C/I人数', '状態', '日付', '曜日', '部屋',
    '人数ソース', '宿泊者名', '予約元',
    '本日IN', '本日OUT', '次回IN日', '泊数', '食事', '備考', '更新日時',
  ];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#e8eaed');
  sh.getRange(1, C.STAFF_DAY, 1, 4).setBackground('#FFF2CC');
  sh.setFrozenRows(1);
  // スマホでも手動列 A〜D が残るよう固定
  sh.setFrozenColumns(C.STAFF_NIGHT);
  return sh;
}

// ============================================================
//  7. Check-In Form 未提出の警告 (E列を赤字にする)
// ============================================================

/**
 * 「チェックイン日が 今日 - DAYS_AGO なのに Check-In Form が未提出」の
 * 滞在について、清掃ボードの E列(キー) を赤字にする行番号を求める。
 *
 * フォーム提出の有無は applyOptionsInfo が立てる stay.formDone で見る。
 * LatestOptions に (宿泊日, 部屋) で突合できた滞在が「提出済み」。
 * 論理削除された行は applyOptionsInfo 側で除外済みなので、
 * キャンセルや再提出で消えた行は提出済みに数えない。
 *
 * @param {Array<Object>} stays
 * @param {Array<Array>}  rows  renderCleaningRows() の戻り値
 * @return {Array<number>} rows 内のインデックス (0始まり)
 */
function computeCheckinFormAlertRows(stays, rows) {
  const A = CONFIG.CHECKIN_FORM_ALERT || {};
  const C = CONFIG.COL_CLEAN;
  const WS = CONFIG.CLEANING.WRITE_START_COL;

  const daysAgo = (A.DAYS_AGO == null) ? 1 : Number(A.DAYS_AGO);
  const today = fmtDate(todayJst());

  // DAYS_AGO=1 なら昨日だけ。2以上なら その日数分さかのぼって全部対象。
  const targets = {};
  for (let i = 1; i <= Math.max(1, daysAgo); i++) {
    targets[addDaysStr(today, -i)] = true;
  }

  const pending = {};
  let n = 0;
  stays.forEach(s => {
    if (!targets[s.checkin]) return;
    // null = フォームを読めていない (判定不能)。
    // 誤って全員を未提出扱いにしないよう、赤字は付けない。
    if (s.formDone === null || s.formDone === undefined) return;
    if (s.formDone) return;
    pending[`${s.checkin}|${s.room}`] = true;
    n++;
    dlog(`Check-In Form 未提出: ${s.checkin} ${s.room} ${s.name || '(氏名未取得)'}`);
  });
  if (!n) return [];

  const out = [];
  rows.forEach((r, i) => {
    if (pending[`${r[C.DATE - WS]}|${r[C.ROOM - WS]}`]) out.push(i);
  });
  return out;
}

/**
 * 上で求めた行の E列(キー) に赤字を適用する。
 *
 * ★毎回 E列全体を既定の書式に戻してから付け直す。
 *   戻さないと、フォームが後から提出されても赤いままになる。
 *   値の書き込み (writeCleaningBoard) は書式を変えないため、
 *   ここで明示的に戻す必要がある。
 *
 * ★色は濃い赤 + 太字。状態が「OUT→IN」の行は条件付き書式で
 *   背景が赤系になるため、明るい赤だと読めなくなる。
 *
 * @return {number} 赤字にした行数
 */
function applyCheckinFormAlerts(stays, rows) {
  const A = CONFIG.CHECKIN_FORM_ALERT || {};
  const C = CONFIG.COL_CLEAN;
  const sh = ensureCleaningSheet();
  const last = sh.getLastRow();

  // 1. 前回の赤字を戻す (ヘッダー行は触らない)
  if (last > 1) {
    sh.getRange(2, C.KEY, last - 1, 1)
      .setFontColor('#000000')
      .setFontWeight('normal');
  }

  if (A.ENABLED === false) return 0;

  // 2. 対象行に赤字を付ける
  const idxs = computeCheckinFormAlertRows(stays, rows);
  const color = A.COLOR || '#A50E0E';
  idxs.forEach(i => {
    const cell = sh.getRange(i + 2, C.KEY);   // rows[0] はシート2行目
    cell.setFontColor(color);
    if (A.BOLD !== false) cell.setFontWeight('bold');
  });

  return idxs.length;
}

/**
 * 未提出者を一覧で確認する (書き込みなし)。
 * 「誰に催促すればよいか」をログで見たいとき用。
 */
function listPendingCheckinForms() {
  const bookings = loadLodgifyBookings();
  const stays = readStaysFromReservations();
  mergeLodgifyStays(stays, bookings);
  applyLodgifyPeople(stays, bookings);
  applyOptionsInfo(stays);
  applyOverride(stays);
  const map = applyCheckinFormStatus(stays);
  if (map === null) {
    Logger.log('!! Check-In Form を読めていません。dumpCheckinForm() で確認してください。');
    return 0;
  }

  const A = CONFIG.CHECKIN_FORM_ALERT || {};
  const daysAgo = (A.DAYS_AGO == null) ? 1 : Number(A.DAYS_AGO);
  const today = fmtDate(todayJst());

  Logger.log(`=== Check-In Form 未提出 (チェックイン日が ${daysAgo} 日前まで) ===`);
  let n = 0;
  for (let i = 1; i <= Math.max(1, daysAgo); i++) {
    const d = addDaysStr(today, -i);
    stays.filter(s => s.checkin === d && !s.formDone).forEach(s => {
      Logger.log(`  ${s.checkin} ${s.room} ${s.name || '(氏名未取得)'} ` +
                 `${s.people || '?'}名 ${s.nights}泊 予約元=${s.lodgifySource || s.source}`);
      n++;
    });
  }
  if (!n) Logger.log('  未提出はありません。');
  return n;
}

/**
 * CleaningBoard に条件付き書式を設定する (手動1回実行)
 * 判定は G列「状態」を見る。
 *   OUT→IN   → 赤   (同日入替。最も忙しい)
 *   OUT→空室 → 橙   (退室あり)
 *   IN       → 緑   (到着あり)
 *   人数不明 → 備考列だけ黄
 */
function setupCleaningFormatting() {
  const C = CONFIG.COL_CLEAN;
  const sh = ensureCleaningSheet();
  // 固定の 2000 行だと DAYS_AHEAD を伸ばしたときに色の付かない行が
  // 出るため、実際の行数から決める (少し余裕をみる)。
  const maxRow = Math.max(sh.getMaxRows(), sh.getLastRow() + 200, 2000);
  const range = sh.getRange(2, 1, maxRow - 1, C.UPDATED_AT);
  const noteRange = sh.getRange(2, C.NOTE, maxRow - 1, 1);

  sh.clearConditionalFormatRules();
  const rules = [];

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$G2="OUT→IN"')
    .setBackground('#FF7C80').setRanges([range]).build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$G2="OUT→空室"')
    .setBackground('#F4B084').setRanges([range]).build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$G2="IN"')
    .setBackground('#C6E0B4').setRanges([range]).build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=REGEXMATCH($S2&"", "人数不明")')
    .setBackground('#FFE699').setRanges([noteRange]).build());

  sh.setConditionalFormatRules(rules);
  Logger.log('CleaningBoard conditional formatting applied.');
}

// ============================================================
//  ユーティリティ
// ============================================================

/**
 * 今日の清掃予定をテキストで返す (LINE通知などへの流用用)
 */
function cleaningTodayText() {
  const C = CONFIG.COL_CLEAN;
  const sh = ensureCleaningSheet();
  const last = sh.getLastRow();
  if (last <= 1) return '';

  const vals = sh.getRange(2, 1, last - 1, C.UPDATED_AT).getValues();
  const today = fmtDate(todayJst());

  const lines = [`【柏屋 清掃 ${today}】`];
  vals.forEach(row => {
    if (fmtDate(row[C.DATE - 1]) !== today) return;
    const parts = [`${row[C.ROOM - 1]}: ${row[C.STATE - 1]}`];
    if (row[C.GUESTS - 1]) parts.push(`${row[C.GUESTS - 1]}名(${row[C.GUESTS_SRC - 1]})`);
    if (row[C.GUEST_NAME - 1]) parts.push(String(row[C.GUEST_NAME - 1]));
    if (row[C.STAFF_DAY - 1]) parts.push(`昼:${row[C.STAFF_DAY - 1]}`);
    if (row[C.STAFF_NIGHT - 1]) parts.push(`夜:${row[C.STAFF_NIGHT - 1]}`);
    if (row[C.NOTE - 1]) parts.push(String(row[C.NOTE - 1]));
    lines.push(parts.join(' / '));
  });

  const text = lines.join('\n');
  Logger.log(text);
  return text;
}

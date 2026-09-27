/**
 * ============================================================
 *  House.gs - 一棟貸し (Vacation-House-Rental) の展開 (v2.15)
 * ============================================================
 *  3部屋目として「一棟貸し」の運用を始めた。
 *  実体は新しい部屋ではなく、1F と 2F を売止にして
 *  無人の一棟貸しとして売り直したもの。
 *  Lodgify 側で部屋貸しと一棟貸しは相互に売止になる。
 *
 *  やること:
 *    一棟貸しの予約1件を「同じ人が 1F と 2F を取った」形の
 *    2件の滞在に展開する。人数はその階で寝る人数に割る。
 *
 *  ★CleaningBoard に3行目は作らない。
 *    CONFIG.CLEANING.ROOMS は ['1F','2F'] のまま。
 *    行数が変わると A〜D列の手動入力が日付ごとずれる。
 *
 *  ★人数の割り振り (運用で決めた表)
 *      X  1F 2F        X  1F 2F
 *      1   1  0        5   3  2
 *      2   2  0        6   4  2
 *      3   2  1        7   4  3
 *      4   2  2        8   4  4
 *    規則にすると「2人ずつ 1F → 2F → 1F → 2F の順に埋める。
 *    各階の上限は4」。上の8件すべてこれで再現できる。
 *
 *  ★売止のゴーストを吸収する
 *    一棟貸しで埋まった夜は 1F/2F が売止になる。
 *    Booking.com の iCal は予約も売止も同じ
 *    "CLOSED - Not available" で配信するため、売止の夜が
 *    1F/2F の予約として入ってくることがある。
 *    そのまま展開すると同じ夜に2件の滞在ができ、
 *    清掃ボードに「⚠同室に複数予約」が出る。
 *    → 一棟貸しの期間に完全に収まる無記名の滞在は吸収する。
 *      氏名が付いている (= 実在の部屋貸し) 場合は吸収せず、
 *      両方に「⚠一棟貸しと部屋貸しが重複」を立てて人に判断させる。
 * ============================================================
 */

/** その部屋キーが一棟貸しか */
function isHouseRoom(room) {
  const H = CONFIG.HOUSE;
  if (!H) return false;
  return String(room == null ? '' : room).trim() === H.ROOM_KEY;
}

/**
 * 一棟貸しの人数を階ごとに割り振る。
 *
 * 2人ずつ 1F → 2F → 1F → 2F の順に埋め、各階 CAP_PER_FLOOR で打ち止め。
 *
 * @param {number|string} x 一棟貸しの総人数
 * @return {{floors:Object, total:number, capped:number, over:number}}
 *   floors … {'1F': n, '2F': n}
 *   total  … 受け取った人数
 *   capped … 実際に割り振れた人数 (定員まで)
 *   over   … 定員を超えた人数 (0 なら問題なし)
 */
function splitHouseGuests(x) {
  const H      = CONFIG.HOUSE;
  const floors = (H && H.FLOORS) || ['1F', '2F'];
  const cap    = (H && H.CAP_PER_FLOOR) || 4;
  const block  = (H && H.FILL_BLOCK) || 2;

  const total = Math.max(0, Math.floor(numOrZero(x)));
  const out = {};
  floors.forEach(f => { out[f] = 0; });

  const capacity = cap * floors.length;
  let left = Math.min(total, capacity);
  const capped = left;

  let i = 0;
  // 安全弁: 1周で最低1人は減るので floors.length * cap 回で必ず終わる
  while (left > 0 && i < floors.length * cap + floors.length) {
    const f    = floors[i % floors.length];
    const room = cap - out[f];
    const take = Math.min(block, room, left);
    out[f] += take;
    left   -= take;
    i++;
  }

  return { floors: out, total: total, capped: capped, over: Math.max(0, total - capacity) };
}

/**
 * 清掃ボードの備考に出す一言を作る。
 * 例) "一棟貸し(全5名: 1F 3名 / 2F 2名)"
 */
function describeHouseSplit(split) {
  const H = CONFIG.HOUSE;
  const floors = (H && H.FLOORS) || ['1F', '2F'];
  const body = floors.map(f => `${f} ${split.floors[f]}名`).join(' / ');
  let s = `${H.NOTE}(全${split.total || '?'}名: ${body})`;
  if (split.over > 0) s += ` ${H.NOTE_OVER}(+${split.over}名)`;
  return s;
}

/** 滞在 a が滞在 b の期間に完全に収まるか (泊単位) */
function stayContainedIn(a, b) {
  if (!a.checkin || !a.checkout || !b.checkin || !b.checkout) return false;
  return a.checkin >= b.checkin && a.checkout <= b.checkout;
}

/** 滞在 a と b の泊が1泊でも重なるか */
function staysOverlap(a, b) {
  if (!a.checkin || !a.checkout || !b.checkin || !b.checkout) return false;
  return a.checkin < b.checkout && b.checkin < a.checkout;
}

/**
 * 一棟貸しの滞在を 1F / 2F の滞在に展開する。
 * stays は破壊的に書き換える (呼び出し側が同じ配列を使い続けるため)。
 *
 * ★applyOptionsInfo() より前に呼ぶこと。
 *   食事とオプションは (宿泊日, 1F/2F) で突合するため、
 *   展開が済んでいないと一棟貸しの食事が清掃ボードに出ない。
 *
 * @param {Array<Object>} stays
 * @return {{houses:number, added:number, absorbed:number, clashes:number, over:number}}
 */
function expandHouseStays(stays) {
  const res = { houses: 0, added: 0, absorbed: 0, clashes: 0, over: 0 };
  const H = CONFIG.HOUSE;
  if (!H || !H.ENABLED) return res;

  const houses = stays.filter(s => isHouseRoom(s.room));
  if (!houses.length) return res;

  const absorbed = [];
  const created  = [];

  houses.forEach(h => {
    res.houses++;
    const split = splitHouseGuests(h.people);
    const label = describeHouseSplit(split);
    if (split.over > 0) res.over++;

    H.FLOORS.forEach(floor => {
      // 同じ階の同じ夜にある既存の滞在を見る
      stays.forEach(s => {
        if (s === h) return;
        if (s.room !== floor) return;
        if (!staysOverlap(s, h)) return;

        // 氏名が付いている = 実在の部屋貸し。一棟貸しと同時に売れたのは異常。
        // 期間がはみ出すものも、吸収すると実在の夜を消すので触らない。
        if (s.name || !stayContainedIn(s, h)) {
          res.clashes++;
          s.notes.push(H.NOTE_CLASH);
          dlog(`一棟貸しと重複: ${floor} ${s.checkin}〜${s.checkout} ` +
               `"${s.name || '(無記名)'}" vs 一棟 ${h.checkin}〜${h.checkout}`);
          return;
        }

        // 売止のゴースト (Booking.com の "CLOSED - Not available")
        absorbed.push(s);
        res.absorbed++;
      });

      const people = split.floors[floor];
      const notes  = (h.notes || []).slice();
      notes.push(people > 0 ? label : `${label} ${H.NOTE_NO_BED}`);

      const s = newStay({
        room:      floor,
        resId:     h.resId,
        source:    h.source,
        checkin:   h.checkin,
        lastNight: h.lastNight,
        checkout:  h.checkout,
        nights:    h.nights,
        people:    people,
        peopleSrc: people > 0 ? `${h.peopleSrc || 'Lodgify'}(一棟按分)` : '一棟按分',
        name:      h.name,
        origin:    h.origin,
        notes:     notes,
      });
      // 人数0は「取得できなかった」ではなく「その階には寝ない」。
      // これを立てないと清掃ボードに「⚠人数不明」が出る。
      s.zeroOk          = true;
      s.fromHouse       = true;
      s.houseTotal      = split.total;
      s.meal            = h.meal || '';
      s.lodgifySource   = h.lodgifySource || '';
      s.lodgifyCheckin  = h.lodgifyCheckin || '';
      s.lodgifyCheckout = h.lodgifyCheckout || '';
      created.push(s);
      res.added++;
    });
  });

  // 一棟貸しの元行と、吸収した売止ゴーストを取り除いてから追加する
  const drop = new Set(houses.concat(absorbed));
  const kept = stays.filter(s => !drop.has(s));
  stays.length = 0;
  kept.forEach(s => stays.push(s));
  created.forEach(s => stays.push(s));

  dlog(`一棟貸しの展開: ${res.houses}件 → ${res.added}行 ` +
       `(売止ゴースト吸収 ${res.absorbed} / 重複 ${res.clashes} / 定員超過 ${res.over})`);
  return res;
}

/**
 * 診断: 一棟貸しの設定と取り込み状況を確認する。書き込みなし。
 *
 * ★最初にこれを実行すること。
 *   ROOM_MAP に一棟貸しの ID を入れていないと、
 *   Lodgify 側に予約があっても「部屋未解決」で捨てられる。
 */
function dumpHouseRentals() {
  const H = CONFIG.HOUSE;
  Logger.log(`=== 一棟貸しの設定 ===`);
  Logger.log(`ENABLED       : ${H.ENABLED}`);
  Logger.log(`ROOM_KEY      : ${H.ROOM_KEY}`);
  Logger.log(`展開先        : ${H.FLOORS.join(' / ')} (各階 上限${H.CAP_PER_FLOOR}名)`);

  const mapped = Object.keys(CONFIG.LODGIFY.ROOM_MAP || {})
    .filter(k => CONFIG.LODGIFY.ROOM_MAP[k] === H.ROOM_KEY);
  if (!mapped.length) {
    Logger.log(`\n!! ROOM_MAP に一棟貸しの ID がありません。`);
    Logger.log(`   このままだと Lodgify の一棟貸し予約は「部屋未解決」で捨てられます。`);
    Logger.log(`   「🔍 Lodgify レスポンス確認」(dumpLodgifyBookings) を実行し、`);
    Logger.log(`   ログ末尾の「部屋を解決できなかった生値」を`);
    Logger.log(`   CONFIG.LODGIFY.ROOM_MAP に '<その値>': '${H.ROOM_KEY}' として追記してください。`);
  } else {
    Logger.log(`ROOM_MAP の ID: ${mapped.join(' / ')}`);
  }

  Logger.log(`\n=== 人数の割り振り表 ===`);
  for (let x = 1; x <= H.CAP_PER_FLOOR * H.FLOORS.length + 1; x++) {
    const sp = splitHouseGuests(x);
    Logger.log(`  ${x}名 → ` + H.FLOORS.map(f => `${f} ${sp.floors[f]}`).join(' / ') +
               (sp.over ? `  ${H.NOTE_OVER}(+${sp.over})` : ''));
  }

  //  ★ここは API ではなく LodgifyBookings シートを読む。
  //    ID を登録してもバッチを回すまではシートの部屋が空欄のままなので、
  //    「0件」の原因にバッチ未実行が含まれる。切り分けられるように
  //    部屋が空欄の行数も数えて出す。
  const bookings = loadLodgifyBookings().filter(b => isHouseRoom(b.room));
  Logger.log(`\n=== LodgifyBookings の一棟貸し: ${bookings.length}件 ===`);
  Logger.log('(このシートはバッチが書く。API を直接見ているのではない)');
  bookings.forEach(b => {
    const sp = splitHouseGuests(b.people);
    Logger.log(`  ${b.checkin}→${b.checkout} ${b.name || '(氏名なし)'} ${b.people}名 → ` +
               H.FLOORS.map(f => `${f} ${sp.floors[f]}名`).join(' / '));
  });

  if (!bookings.length) {
    const unresolved = countLodgifyRowsWithoutRoom_();
    Logger.log('  0件でした。原因は次のどれかです。');
    if (unresolved > 0) {
      Logger.log(`   ★1) バッチ未実行。部屋が空欄の行が ${unresolved} 件あります。`);
      Logger.log('      → 「🔄 バッチ実行」か「🏨 Lodgify取得だけ実行」を回せば解決されます。');
    } else {
      Logger.log('    1) バッチ未実行 … ではありません (部屋が空欄の行は0件)。');
    }
    Logger.log('    2) ROOM_MAP の ID 違い … 「🔍 Lodgify レスポンス確認」で');
    Logger.log('       「部屋を解決できなかった生値」が出ないか確認してください。');
    Logger.log('    3) そもそも一棟貸しの予約が無い (ステータスが Booked 以外だと');
    Logger.log(`       取り込まれません。VALID_STATUS = ${JSON.stringify(CONFIG.LODGIFY.VALID_STATUS)})`);
  }
}

/**
 * LodgifyBookings で部屋が解決できていない行 (論理削除を除く) を数える。
 * 「ID は登録したがバッチをまだ回していない」を見分けるため。
 */
function countLodgifyRowsWithoutRoom_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET.LODGIFY);
  if (!sh) return 0;
  const last = sh.getLastRow();
  if (last <= 1) return 0;

  const C = CONFIG.COL_LDG;
  const width = Math.min(CONFIG.LDG_WIDTH, sh.getLastColumn());
  const vals = sh.getRange(2, 1, last - 1, width).getValues();

  let n = 0;
  vals.forEach(row => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    if (String(row[C.ROOM - 1] || '').trim()) return;
    n++;
  });
  return n;
}

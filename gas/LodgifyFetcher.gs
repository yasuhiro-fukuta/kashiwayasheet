/**
 * ============================================================
 *  LodgifyFetcher.gs - Lodgify Public API v2 取得と蓄積 (v2.10)
 * ============================================================
 *  目的:
 *    iCal には人数が入っておらず、現行フォームにも人数設問が無い。
 *    人数の権威データを得られる唯一の経路が Lodgify API なので、
 *    ここで取得して LodgifyBookings シートに蓄積する。
 *    直予約 (自社予約ページ・管理画面入力) もここにしか出てこない。
 *
 *  ── v2.10 の修正 ──────────────────────────────────────────
 *   ・upsert キーを 予約ID + 部屋(1F/2F) から
 *     予約ID + 部屋(生値=room_type_id) に変更した。
 *     旧キーは ROOM_MAP を直すと値が変わるため、同じ予約が
 *     「古い行=削除」「新しい行」の2行に分裂していた。
 *     実データで Adrian Lipkovits (id=22483640) が2行に増えており、
 *     削除フラグの立った行が 149 行まで膨らんでいた。
 *     room_type_id は API 側の安定値なのでキーとして正しい。
 *   ・VALID_STATUS で弾いた予約を件数付きでログに出すようにした。
 *     以前は黙って捨てていたため、ステータス名が増えたときに
 *     「なぜか予約が消える」形で気付きにくかった。
 *
 *  APIキーの取得先:
 *    https://app.lodgify.com/#/reservation/settings/publicApiToken
 *    取得したら setLodgifyApiKey('xxx') で Script Properties に保存する。
 *
 *  蓄積方式 (upsert):
 *    キー = 予約ID + '|' + 部屋(生値)
 *    ・既存行があれば同じ行を上書き更新 (初回取得日時と手書き備考は保持)
 *    ・無ければ末尾に追記
 *    ・今回の取得結果に現れなかった行は論理削除フラグに「削除」を立てる
 *      物理削除はしない。過去実績を残すため。
 *    ・一度「削除」が立った行が再び現れたらフラグを消して復活させる
 *
 *  ★注意: stayFilter の既定値は 'upcoming'。値の綴りを誤ると
 *    無効値として既定に落ち、「なぜか過去の予約が取れない」という
 *    形で静かに壊れる。サポートが明示した小文字表記に厳密に合わせること。
 * ============================================================
 */

/** Lodgify の size パラメータ上限 (サポート回答: max 50 per page) */
const LODGIFY_MAX_PAGE_SIZE = 50;

/**
 * Lodgify から予約を取得し LodgifyBookings に upsert する。
 * @param {Date} now バッチ基準時刻
 * @return {{fetched:number, inserted:number, updated:number, removed:number}}
 */
function syncLodgifyBookings(now) {
  const result = { fetched: 0, inserted: 0, updated: 0, removed: 0, direct: 0 };

  if (!CONFIG.LODGIFY.ENABLED) {
    dlog('Lodgify sync skipped: CONFIG.LODGIFY.ENABLED = false');
    return result;
  }

  const apiKey = getLodgifyApiKey();
  if (!apiKey) {
    dlog('Lodgify sync skipped: API key not set. Run setLodgifyApiKey().');
    return result;
  }

  const raw = fetchLodgifyBookings(apiKey);

  const skipped = {};
  const items = [];
  raw.forEach(b => {
    const norm = normalizeLodgifyBooking(b, skipped);
    norm.forEach(n => items.push(n));
  });
  result.fetched = items.length;
  result.direct = items.filter(i => isDirectLodgifySource(i.source)).length;

  dlog(`Lodgify: ${raw.length} bookings → ${items.length} room-rows ` +
       `(うち直予約 ${result.direct})`);
  if (Object.keys(skipped).length) {
    // 取り込まなかった理由の内訳。ステータス名が増えたときはここに出る。
    dlog(`Lodgify: 取り込まなかった予約 ${JSON.stringify(skipped)} ` +
         `(VALID_STATUS = ${JSON.stringify(CONFIG.LODGIFY.VALID_STATUS)})`);
  }

  const sh = ensureLodgifySheet();
  const C = CONFIG.COL_LDG;
  const width = 19;

  const last = sh.getLastRow();
  const existing = (last > 1) ? sh.getRange(2, 1, last - 1, width).getValues() : [];

  // 既存行のキー → 行インデックス (0始まり)
  //
  //  ★キーを 部屋 → 部屋(生値) に変えた影響で、旧キー時代に分裂した
  //    「削除フラグ付きの古い行」と「生きている行」が同じキーになる。
  //    その場合は必ず生きている行に更新をかける (古い行は削除のまま残す)。
  const rowByKey = {};
  existing.forEach((row, i) => {
    const k = lodgifyRowKey(row[C.BOOKING_ID - 1], row[C.ROOM_RAW - 1]);
    if (!k) return;
    const prev = rowByKey[k];
    if (prev === undefined) { rowByKey[k] = i; return; }
    const prevDeleted = (existing[prev][C.DELETED_FLAG - 1] === '削除');
    const thisDeleted = (row[C.DELETED_FLAG - 1] === '削除');
    // 生きている行を優先。どちらも同じ状態なら後勝ち。
    if (prevDeleted && !thisDeleted) rowByKey[k] = i;
    else if (prevDeleted === thisDeleted) rowByKey[k] = i;
  });

  const seenKeys = {};
  const appends = [];

  items.forEach(it => {
    const key = lodgifyRowKey(it.bookingId, it.roomRaw);
    if (!key) return;
    seenKeys[key] = true;

    const idx = rowByKey[key];
    if (idx === undefined) {
      appends.push(lodgifyItemToRow(it, now, now));
    } else {
      const firstSeen = existing[idx][C.FIRST_SEEN - 1] || now;
      const updated = lodgifyItemToRow(it, now, firstSeen);
      // 手書きの備考は保持する (バッチで消さない)
      updated[C.NOTE - 1] = existing[idx][C.NOTE - 1] || '';
      existing[idx] = updated;
      result.updated++;
    }
  });

  // 今回現れなかった行に削除フラグを立てる
  existing.forEach(row => {
    const k = lodgifyRowKey(row[C.BOOKING_ID - 1], row[C.ROOM_RAW - 1]);
    if (!k) return;
    if (seenKeys[k]) return;
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    row[C.DELETED_FLAG - 1] = '削除';
    row[C.FETCHED_AT - 1] = now;
    result.removed++;
  });

  // 書き戻し
  if (existing.length > 0) {
    sh.getRange(2, 1, existing.length, width).setValues(existing);
  }
  if (appends.length > 0) {
    sh.getRange(existing.length + 2, 1, appends.length, width).setValues(appends);
    result.inserted = appends.length;
  }

  dlog(`Lodgify upsert: +${result.inserted} / ~${result.updated} / -${result.removed}`);
  return result;
}

/**
 * upsert キーを組み立てる。
 *
 * ★部屋は「解決後の 1F/2F」ではなく「生値 (room_type_id)」を使う。
 *   解決後の値は ROOM_MAP 次第で変わるため、マッピングを直すたびに
 *   同じ予約が別行として増えてしまう。
 *   シートから読むと数値が 860952 のように Number 型で返るので、
 *   小数点以下を落としてから文字列化する。
 */
function lodgifyRowKey(bookingId, roomRaw) {
  const id = String(bookingId == null ? '' : bookingId).trim().replace(/\.0+$/, '');
  let raw = (roomRaw == null) ? '' : roomRaw;
  if (typeof raw === 'number') raw = String(Math.round(raw));
  raw = String(raw).trim().replace(/\.0+$/, '');
  if (!id) return '';
  return `${id}|${raw}`;
}

/**
 * Script Properties から APIキーを取得
 */
function getLodgifyApiKey() {
  return PropertiesService.getScriptProperties().getProperty(CONFIG.LODGIFY.PROP_KEY) || '';
}

/**
 * Lodgify API をページングしながら全件取得する。
 *
 * 送るパラメータはサポートが明示したものだけに絞っている:
 *   stayFilter=all       … 既定は 'upcoming'。小文字必須
 *   includeExternal=true … OTA(Booking.com/Airbnb)経由の予約を含める
 *   page / size          … size は最大 50
 *
 * @return {Array<Object>} 生の booking オブジェクト配列
 */
function fetchLodgifyBookings(apiKey) {
  const L = CONFIG.LODGIFY;
  const size = Math.min(Number(L.PAGE_SIZE) || LODGIFY_MAX_PAGE_SIZE, LODGIFY_MAX_PAGE_SIZE);
  const all = [];

  for (let page = 1; page <= L.MAX_PAGES; page++) {
    const url = L.API_BASE
      + '?stayFilter=all'          // ← 小文字。'All' だと既定の upcoming に落ちる
      + '&includeExternal=true'
      + `&page=${page}`
      + `&size=${size}`;

    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'X-ApiKey': apiKey,
        'accept':   'application/json',
      },
      muteHttpExceptions: true,
    });

    const code = res.getResponseCode();
    if (code !== 200) {
      throw new Error(`Lodgify API HTTP ${code}: ${res.getContentText().substring(0, 300)}`);
    }

    const body = JSON.parse(res.getContentText());
    const items = body.items || body.Items || [];
    if (items.length === 0) break;

    items.forEach(i => all.push(i));
    dlog(`Lodgify page ${page}: ${items.length} items (total ${all.length})`);

    if (items.length < size) break;   // 最終ページ
    Utilities.sleep(300);             // レート制限対策
  }

  return all;
}

/**
 * 1 booking を「部屋ごとの1行」に正規化する。
 * 1予約で2部屋押さえている場合は2行返る。
 *
 * @param {Object} b
 * @param {Object} [skipped] 取り込まなかった理由のカウンタ (任意)
 */
function normalizeLodgifyBooking(b, skipped) {
  const bump = (reason) => {
    if (skipped) skipped[reason] = (skipped[reason] || 0) + 1;
  };

  const status = String(b.status || b.Status || '').toLowerCase();
  if (CONFIG.LODGIFY.VALID_STATUS.indexOf(status) < 0) {
    bump(`status:${status || '(空)'}`);
    return [];
  }

  const checkin  = toDate(b.arrival   || b.date_arrival);
  const checkout = toDate(b.departure || b.date_departure);
  if (!checkin || !checkout || isNaN(checkin.getTime()) || isNaN(checkout.getTime())) {
    bump('日付が読めない');
    return [];
  }

  const guest  = b.guest || {};
  const name   = guest.name || guest.Name || b.guest_name || '';
  const src    = b.source_text || b.source || b.origin || '';
  const nights = Math.max(1, Math.round((checkout.getTime() - checkin.getTime()) / 86400000));

  let rooms = b.rooms || b.Rooms || [];
  if (!rooms.length) {
    rooms = [{ room_type_id: b.property_id, people: b.people, name: b.property_name }];
  }

  return rooms.map(rm => {
    const bd       = rm.guest_breakdown || {};
    const adults   = numOrZero(bd.adults);
    const children = numOrZero(bd.children);
    const people   = numOrZero(rm.people) || (adults + children) || 0;

    const roomRaw = rm.room_type_id || rm.name || rm.room_type_name || b.property_id || '';
    const room    = resolveLodgifyRoom(rm, b);
    if (!room) bump(`部屋未解決:${roomRaw}`);

    return {
      bookingId: String(b.id || b.Id || ''),
      status:    status,
      room:      room,
      roomRaw:   String(roomRaw),
      name:      name,
      people:    people,
      adults:    adults,
      children:  children,
      checkin:   checkin,
      checkout:  checkout,
      nights:    nights,
      source:    src,
      amount:    numOrZero(b.total_amount || b.total),
      currency:  b.currency_code || '',
      raw:       JSON.stringify(b).substring(0, 4000),
    };
  });
}

/**
 * 部屋を 1F / 2F に解決する。
 * 名前 → normalizeRoom() を最優先。次に ROOM_MAP の ID 引き。
 */
function resolveLodgifyRoom(rm, b) {
  const byName = normalizeRoom(rm.name || rm.room_type_name || b.property_name || '');
  if (byName) return byName;

  const map = CONFIG.LODGIFY.ROOM_MAP || {};
  const rtid = String(rm.room_type_id || '');
  if (map[rtid]) return map[rtid];

  const pid = String(b.property_id || '');
  if (map[pid]) return map[pid];

  return '';
}

/**
 * 正規化済みアイテムを LodgifyBookings の1行 (19列) に変換
 */
function lodgifyItemToRow(it, fetchedAt, firstSeen) {
  const C = CONFIG.COL_LDG;
  const row = new Array(19).fill('');

  row[C.FETCHED_AT - 1]   = fetchedAt;
  row[C.FIRST_SEEN - 1]   = firstSeen;
  row[C.DELETED_FLAG - 1] = '';
  row[C.BOOKING_ID - 1]   = it.bookingId;
  row[C.STATUS - 1]       = it.status;
  row[C.ROOM - 1]         = it.room;
  row[C.ROOM_RAW - 1]     = it.roomRaw;
  row[C.GUEST_NAME - 1]   = it.name;
  row[C.GUESTS - 1]       = it.people || '';
  row[C.ADULTS - 1]       = it.adults || '';
  row[C.CHILDREN - 1]     = it.children || '';
  row[C.CHECKIN - 1]      = it.checkin;
  row[C.CHECKOUT - 1]     = it.checkout;
  row[C.NIGHTS - 1]       = it.nights;
  row[C.SOURCE - 1]       = it.source;
  row[C.AMOUNT - 1]       = it.amount || '';
  row[C.CURRENCY - 1]     = it.currency;
  row[C.RAW_JSON - 1]     = it.raw;
  row[C.NOTE - 1]         = '';

  return row;
}

/**
 * LodgifyBookings シートを用意する (無ければヘッダー付きで作成)
 */
function ensureLodgifySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CONFIG.SHEET.LODGIFY);
  if (sh) return sh;

  sh = ss.insertSheet(CONFIG.SHEET.LODGIFY);
  const header = [
    '最終取得日時', '初回取得日時', '論理削除フラグ', '予約ID', 'ステータス',
    '部屋', '部屋(生値)', '宿泊者名', '人数', '大人', '子供',
    'チェックイン', 'チェックアウト', '泊数', '予約元',
    '金額', '通貨', '原文JSON', '備考(手動)',
  ];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#e8eaed');
  sh.setFrozenRows(1);
  sh.setColumnWidth(CONFIG.COL_LDG.RAW_JSON, 60);
  return sh;
}

/**
 * 診断: 実際に返ってくる room_type_id / 部屋名 / 人数 / ステータスを確認する。
 * ROOM_MAP を埋める前に必ずこれを実行してログを見ること。
 *
 * 確認すべきポイント:
 *   ・取得件数が 0 でないか
 *   ・people に実数が入っているか
 *   ・status にどんな値が来るか (CONFIG.LODGIFY.VALID_STATUS の調整用)
 *   ・部屋がすべて 1F / 2F に解決できているか
 *   ・直予約 (source が自社ドメイン) が含まれているか
 */
function dumpLodgifyBookings() {
  const apiKey = getLodgifyApiKey();
  if (!apiKey) {
    Logger.log('APIキー未設定。setLodgifyApiKey("xxx") を先に実行してください。');
    return;
  }

  const items = fetchLodgifyBookings(apiKey);
  Logger.log(`=== 取得件数: ${items.length} ===`);

  if (items.length === 0) {
    Logger.log('0件です。stayFilter / includeExternal と APIキーを確認してください。');
    return;
  }

  const statusCount = {};
  const srcCount = { direct: 0, ota: 0 };
  items.forEach(b => {
    const s = String(b.status || '').toLowerCase();
    statusCount[s] = (statusCount[s] || 0) + 1;
    const src = b.source_text || b.source || b.origin || '';
    if (isDirectLodgifySource(src)) srcCount.direct++; else srcCount.ota++;
  });
  Logger.log(`--- status 分布 --- ${JSON.stringify(statusCount)}`);
  Logger.log(`(CONFIG.LODGIFY.VALID_STATUS = ${JSON.stringify(CONFIG.LODGIFY.VALID_STATUS)})`);
  Logger.log(`--- 直予約 ${srcCount.direct} 件 / OTA ${srcCount.ota} 件 ---`);

  Logger.log('--- 直予約の一覧 ---');
  items.forEach(b => {
    const src = b.source_text || b.source || b.origin || '';
    if (!isDirectLodgifySource(src)) return;
    Logger.log(`  id=${b.id} ${fmtDate(b.arrival)}→${fmtDate(b.departure)} ` +
      `${(b.guest && b.guest.name) || '-'} src="${src}" status=${b.status}`);
  });

  Logger.log('--- 先頭15件 ---');
  items.slice(0, 15).forEach(b => {
    const rooms = (b.rooms || []).map(r =>
      `[name=${r.name || r.room_type_name || '-'} / room_type_id=${r.room_type_id} / people=${r.people}]`
    ).join(' ');
    Logger.log(
      `id=${b.id} property_id=${b.property_id} status=${b.status} ` +
      `src=${b.source_text || b.source || '-'} ` +
      `${fmtDate(b.arrival)}→${fmtDate(b.departure)} ` +
      `guest=${(b.guest && b.guest.name) || '-'} ${rooms}`
    );
  });

  const unresolved = [];
  let withPeople = 0, total = 0;
  items.forEach(b => {
    normalizeLodgifyBooking(b).forEach(n => {
      total++;
      if (!n.room) unresolved.push(n.roomRaw);
      if (n.people > 0) withPeople++;
    });
  });

  Logger.log(`\n--- 正規化後 ${total} 行 / 人数が取れたもの ${withPeople} 行 ---`);
  if (unresolved.length) {
    Logger.log('!! 部屋を解決できなかった生値 (CONFIG.LODGIFY.ROOM_MAP に追記が必要):');
    Logger.log([...new Set(unresolved)].join(' / '));
  } else {
    Logger.log('部屋はすべて 1F / 2F に解決できました。');
  }
}

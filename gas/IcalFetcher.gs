/**
 * ============================================================
 *  IcalFetcher.gs - iCal取得とパース
 * ============================================================
 *  CONFIG.ICAL_SOURCES の 4本の iCal を取得し、
 *  予約オブジェクトの配列に正規化する。
 *
 *  ★ここに出てくるのは OTA (Booking.com / Airbnb) 経由の予約だけ。
 *    Lodgify の直予約は含まれない。直予約は LodgifyFetcher.gs が
 *    API から取り、CleaningBoard.gs の mergeLodgifyStays() が
 *    清掃ボードの骨格に合流させる。
 *
 *  Booking.com:
 *    - SUMMARY は常に "CLOSED - Not available"
 *    - ゲスト名・電話番号は含まれない
 *    - 1泊 = 1 VEVENT (連泊は VEVENT が分裂)
 *  Airbnb:
 *    - SUMMARY は "Reserved" 固定
 *    - DESCRIPTION に予約コード (HMxxxxxx)
 *    - 連泊は1 VEVENTでまとめられる
 *    - ホスト手動ブロックや相互ブロックは DESCRIPTION に HMxxx なし
 *      → これらは除外する
 *
 *  出力形式:
 *  {
 *    source:        'booking' | 'airbnb',
 *    uid:           string,
 *    reservationId: string,
 *    room:          '1F' | '2F',
 *    checkin:       Date,
 *    checkout:      Date,
 *    identifier:    string,
 *  }
 * ============================================================
 */

/**
 * 全 iCal ソースから予約を取得し、1日単位に展開して返す
 */
function fetchAllReservations() {
  const all = [];
  for (const src of CONFIG.ICAL_SOURCES) {
    try {
      const items = fetchIcal(src);
      dlog(`Fetched ${items.length} raw events from ${src.source} ${src.room}`);
      all.push(...items);
    } catch (e) {
      Logger.log(`ERROR fetching ${src.source} ${src.room}: ${e}`);
    }
  }
  const expanded = expandToNightly(all);
  return dedupeByDateAndRoom(expanded);
}

/**
 * 1本のiCalを取得してパース
 */
function fetchIcal(srcConfig) {
  const options = {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; KashiwayaSync/1.0)',
      'Accept':     'text/calendar, text/plain, */*',
    },
  };
  const res = UrlFetchApp.fetch(srcConfig.url, options);
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error(`HTTP ${code} from ${srcConfig.url}`);
  }
  const text = res.getContentText();
  const vevents = parseIcal(text);
  return vevents
    .map(ev => normalizeEvent(ev, srcConfig))
    .filter(Boolean);
}

/**
 * iCalテキストのパース
 */
function parseIcal(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .reduce((acc, line) => {
      if ((line.startsWith(' ') || line.startsWith('\t')) && acc.length) {
        acc[acc.length - 1] += line.substring(1);
      } else {
        acc.push(line);
      }
      return acc;
    }, []);

  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const rawKey = line.substring(0, idx);
      const value = line.substring(idx + 1);
      const key = rawKey.split(';')[0];
      cur[key] = value;
    }
  }
  return events;
}

/**
 * 1 VEVENT を予約オブジェクトに正規化
 *
 * Airbnb の場合、DESCRIPTION から HMxxx が取れない VEVENT は
 * ホスト手動ブロック or 相互ブロックとみなし、null を返して除外する。
 */
function normalizeEvent(ev, srcConfig) {
  const uid = ev.UID;
  if (!uid) return null;
  const dtstart = ev.DTSTART;
  const dtend = ev.DTEND;
  if (!dtstart || !dtend) return null;

  const checkin = toDate(dtstart);
  const checkout = toDate(dtend);
  if (!checkin || !checkout) return null;

  let identifier = '';
  if (srcConfig.source === 'airbnb') {
    const desc = ev.DESCRIPTION || '';
    const m = desc.match(/reservations\/details\/(HM[A-Z0-9]+)/);
    if (!m) {
      // HMxxx が取れない = 本物の予約ではない (ブロック) → 除外
      return null;
    }
    identifier = `[Airbnb: ${m[1]}]`;
  }

  return {
    source:        srcConfig.source,
    uid:           uid,
    reservationId: `${srcConfig.source}_${uid}`,
    room:          srcConfig.room,
    checkin:       checkin,
    checkout:      checkout,
    identifier:    identifier,
  };
}

/**
 * 複数日にまたがる予約を1日単位に展開
 */
function expandToNightly(items) {
  const result = [];
  for (const item of items) {
    const startMs = item.checkin.getTime();
    const endMs = item.checkout.getTime();
    const oneDay = 24 * 60 * 60 * 1000;
    for (let t = startMs; t < endMs; t += oneDay) {
      const ci = new Date(t);
      const co = new Date(t + oneDay);
      result.push({
        ...item,
        checkin:  ci,
        checkout: co,
      });
    }
  }
  return result;
}

/**
 * 宿泊日×部屋キーでの重複排除
 * BookingとAirbnbで同じ日を押さえている場合は Booking 優先
 */
function dedupeByDateAndRoom(items) {
  const keyOf = i => `${fmtDate(i.checkin)}|${i.room}`;
  const booking = items.filter(i => i.source === 'booking');
  const airbnb  = items.filter(i => i.source === 'airbnb');

  const bookingKeys = new Set(booking.map(keyOf));
  const result = [...booking];
  for (const a of airbnb) {
    if (!bookingKeys.has(keyOf(a))) result.push(a);
  }
  return result;
}

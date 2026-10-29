/**
 * ============================================================
 *  FormReconcile.gs - 食事フォームの宿泊日・部屋を Lodgify 予約に合わせる (v1.00)
 * ============================================================
 *  2026-10-30 追加（社長「原因を調べて直す」）。
 *
 *  ★起きていたこと
 *    食事フォーム（Booking.com客向け）はお客様が自分で宿泊日・部屋を選ぶ。
 *    選び間違い・古い予約のままの回答が LatestOptions にそのまま入り、
 *    別のお客様の日・部屋に食事が付いていた。
 *      ・Marina Kuneman 11/1 1F … 3月の回答。予約は無く、その日の1Fは別のお客様
 *      ・Livia Ishida  11/7 1F … 予約は 2F（フォームの部屋の選び間違い）
 *      ・Megan Gray    11/10 1F … 予約は 11/11（フォームの日付の選び間違い）
 *    その結果、清掃ボードの食事と注文確認票のメモが「人数の倍」や
 *    「別人の名前」になっていた。
 *
 *  ★やること（毎時バッチ、フォーム取込の直後）
 *    フォーム由来の有効な行（Lodgify アドオン行は対象外）について、
 *    宿泊者名が一致する有効な Lodgify 予約を探す。
 *      ① 見つかった → 宿泊日・部屋を予約に合わせて直す（部屋は予約が
 *         1F／2F のときだけ。一棟貸しは部屋を触らない）。
 *      ② 見つからない、かつ その日・その部屋には別のお客様の有効な予約がある
 *         → 古い回答とみなして論理削除（「削除」）。
 *      ③ 見つからない、かつ その日・その部屋が空いている → 触らない
 *         （予約の取り込み待ちの可能性があるため）。
 *    直した・消したセルにはメモで理由（元の値）を残す。
 *
 *  ★部屋・日付は Lodgify 予約が正（2026-10-25 社長決定）。
 *  ★過去の宿泊日（昨日より前）は触らない。
 * ============================================================
 */

const FORM_RECONCILE_MAX_SHIFT_DAYS_ = 7;   // 名前一致の予約を採る日付のずれの上限

function reconcileFormOptionsWithLodgify(optSh, now) {
  const res = { moved: [], deleted: [] };
  const last = optSh.getLastRow();
  if (last <= 1) return res;

  const bookings = readActiveLodgifyStays_();
  if (!bookings.length) return res;   // 予約が読めないときは何もしない

  const C = CONFIG.COL_OPT;
  const vals = optSh.getRange(2, 1, last - 1, C.FORM_JSON).getValues();
  const yesterday = fmtDate(new Date(todayJst().getTime() - 86400000));

  vals.forEach((row, idx) => {
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    if (lodgifyOptionMeta(row)) return;               // アドオン行は予約IDで管理済み
    const d = fmtDate(row[C.CHECKIN - 1]);
    const room = String(row[C.ROOM - 1] || '').trim();
    const name = String(row[C.GUEST_NAME - 1] || '').trim();
    if (!d || !name || d < yesterday) return;

    const rowIdx = idx + 2;
    const hit = nearestBookingByName_(bookings, name, d);

    if (hit) {
      const newRoom = (hit.room === '1F' || hit.room === '2F') ? hit.room : room;
      if (hit.arrival === d && newRoom === room) return;
      optSh.getRange(rowIdx, C.CHECKIN).setValue(hit.arrival);   // 文字列で書く（シートTZでその日の0時になり、fmtDate でも同じ日）
      optSh.getRange(rowIdx, C.ROOM).setValue(newRoom);
      appendCellNote_(optSh.getRange(rowIdx, C.CHECKIN),
        `[自動修正 ${fmtDateTime(now)}] Lodgify予約(${hit.id})に合わせて ` +
        `${d} ${room} → ${hit.arrival} ${newRoom}`);
      res.moved.push(`${name}: ${d} ${room} → ${hit.arrival} ${newRoom}`);
      return;
    }

    //  名前の書き方が違うだけの同一人物（姓名が逆・愛称・ミドルネーム）が
    //  近い日に泊まっていれば、古い回答とは言い切れないので消さない。
    const lookalike = bookings.some(b => guestNameMatch_(b.name, name) &&
      Math.abs(toDate(b.arrival).getTime() - toDate(d).getTime()) <= FORM_RECONCILE_MAX_SHIFT_DAYS_ * 86400000);
    if (lookalike) return;
    const other = bookings.find(b => b.arrival <= d && d < b.departure &&
      (b.room === room || !(b.room === '1F' || b.room === '2F')));
    if (!other) return;
    optSh.getRange(rowIdx, C.DELETED_FLAG).setValue('削除');
    appendCellNote_(optSh.getRange(rowIdx, C.DELETED_FLAG),
      `[自動削除 ${fmtDateTime(now)}] ${name} の有効な予約が無く、` +
      `${d} ${room} は ${other.name} 様(予約${other.id})の宿泊のため古い回答とみなした`);
    res.deleted.push(`${name}: ${d} ${room}（その日は ${other.name} 様）`);
  });

  if (res.moved.length || res.deleted.length) {
    Logger.log(`フォームの宿泊日・部屋をLodgifyに合わせた: 修正 ${res.moved.length} / 削除 ${res.deleted.length}\n` +
      res.moved.concat(res.deleted).join('\n'));
  }
  return res;
}

/** 有効な Lodgify 予約（論理削除・キャンセル・お断りを除く）。 */
function readActiveLodgifyStays_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET.LODGIFY);
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const C = CONFIG.COL_LDG;
  const rows = sh.getRange(2, 1, last - 1, CONFIG.LDG_WIDTH).getValues();
  const out = [];
  rows.forEach(r => {
    if (r[C.DELETED_FLAG - 1] === '削除') return;
    const status = String(r[C.STATUS - 1] || '').toLowerCase();
    if (/declin|cancel|reject|expired/.test(status)) return;
    const name = String(r[C.GUEST_NAME - 1] || '').trim();
    if (!name) return;
    //  チェックイン列は1日ずれることがあるので JSON の arrival を優先する
    //  ★RAW_JSON はセルの文字数で途中が切れていることがある（JSON.parse 不可）。
    //    その場合も "arrival":"yyyy-MM-dd" を正規表現で拾う。
    let arrival = '', departure = '';
    const raw = String(r[C.RAW_JSON - 1] || '');
    const ma = raw.match(/"(?:date_)?arrival"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
    const md = raw.match(/"(?:date_)?departure"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
    if (ma) arrival = ma[1];
    if (md) departure = md[1];
    if (!arrival)   arrival   = fmtDate(r[C.CHECKIN - 1]);
    if (!departure) departure = fmtDate(r[C.CHECKOUT - 1]);
    if (!arrival) return;
    if (!departure || departure <= arrival) {
      departure = fmtDate(new Date(toDate(arrival).getTime() + 86400000));
    }
    out.push({ id: String(r[C.BOOKING_ID - 1] || ''), name: name,
               room: String(r[C.ROOM - 1] || '').trim(),
               arrival: arrival, departure: departure });
  });
  return out;
}

/**
 * 名前の一致を2段階で見る。
 *   strong … 大小・空白・全半角を無視して同じ／片方を含む／姓名の順だけ違う
 *   weak   … 3文字以上の名前の語を1つ以上共有（愛称・ミドルネーム・表記ゆれ）
 *  @return {''|'strong'|'weak'}
 */
function guestNameMatch_(a, b) {
  if (sameGuestName_(a, b)) return 'strong';
  const toks = x => toHalfWidth(String(x || '')).toLowerCase()
    .split(/[^a-z\u00c0-\u024f\u3040-\u30ff\u4e00-\u9fff]+/).filter(Boolean);
  const ta = toks(a), tb = toks(b);
  if (!ta.length || !tb.length) return '';
  if (ta.slice().sort().join('') === tb.slice().sort().join('')) return 'strong';
  if (ta.join('') === tb.join('') || ta.join('') === tb.slice().reverse().join('')) return 'strong';
  const setB = new Set(tb);
  if (ta.some(t => t.length >= 3 && setB.has(t))) return 'weak';
  //  「LAI MAY LEE」と「Maylee Lai」のように語の切れ目が違う
  const ja = ta.join(''), jb = tb.join('');
  if (tb.some(t => t.length >= 5 && ja.indexOf(t) >= 0) || ta.some(t => t.length >= 5 && jb.indexOf(t) >= 0)) return 'weak';
  return '';
}

/**
 * 名前が一致する予約のうち、宿泊日がいちばん近いもの（上限日数内）。
 *  strong 一致を優先。weak 一致は候補が1人（1予約者名）のときだけ採る。
 */
function nearestBookingByName_(bookings, name, d) {
  const dt = toDate(d).getTime();
  const pick = level => {
    let best = null, bestGap = Infinity;
    const names = new Set();
    bookings.forEach(b => {
      if (guestNameMatch_(b.name, name) !== level) return;
      const inside = b.arrival <= d && d < b.departure;
      const gap = inside ? 0 : Math.abs(toDate(b.arrival).getTime() - dt) / 86400000;
      if (gap > FORM_RECONCILE_MAX_SHIFT_DAYS_) return;
      names.add(String(b.name).toLowerCase().replace(/\s+/g, ''));
      if (gap < bestGap) { best = b; bestGap = gap; }
    });
    if (level === 'weak' && names.size !== 1) return null;
    if (!best) return null;
    //  連泊の途中の日を指した回答は、その日のままにする（部屋だけ合わせる）
    if (best.arrival <= d && d < best.departure) return Object.assign({}, best, { arrival: d });
    return best;
  };
  return pick('strong') || pick('weak');
}

/** セルのメモに1行足す（人が書いたメモは残す）。 */
function appendCellNote_(rng, line) {
  const cur = String(rng.getNote() || '');
  rng.setNote(cur ? `${cur.replace(/\s+$/, '')}\n${line}` : line);
}

/**
 * ============================================================
 *  LodgifyAddons.gs - Lodgify 予約時オプション(Add-ons) の取込 (v2.14)
 * ============================================================
 *  背景:
 *    Lodgify のチェックアウト画面で食事オプションを売り始めた。
 *      例) "Dinner - Chicken Hot Pot for 3"  ¥8,000  x1
 *    これまで食事の注文経路は GoogleForm だけだったので、
 *    Lodgify で頼まれた食事は誰も気付かないまま当日を迎えてしまう。
 *
 *  方針 ── GoogleForm の食事オプションと同じ扱いにする:
 *    LatestOptions (食事予約表) に行を作る。
 *    ここに乗れば、既存の経路がそのまま効く:
 *      ・ほなみやへの発注一覧 (この表がそのまま発注元)
 *      ・applyOptionsInfo() 経由で CleaningBoard の食事列(R)にも出る
 *      ・条件付き書式・曜日数式・並べ替えも共通
 *
 *  ★フォーム由来の行と混ざらないようにする必要がある。
 *    LatestOptions の重複排除 markOlderAsResubmitted() は
 *    (宿泊日, 部屋, 宿泊者名) が同じ古い行を「削除」にする。
 *    素で入れると
 *      「Lodgifyで夕食 + フォームで朝食」を頼んだ客の
 *      フォーム行が毎バッチ消される。
 *    そこで K列(フォーム原文JSON) に出所を埋め、
 *    optKey() を出所込みにして相互に干渉させない。
 *    列は増やしていない (増やすと L列「ほなみや転記済」と
 *    M列の曜日数式がずれる)。
 *
 *  ★アドオンのフィールド名が確定できていない。
 *    公開ドキュメント (docs.lodgify.com) にアドオンの項目が無く、
 *    実レスポンスで確かめる以外の確認手段が無かった。
 *    そのため取り出しは2段構え (CONFIG.LODGIFY.ADDONS 参照):
 *      1) KEYS に挙げた名前の配列 → 無条件に採用
 *      2) 無ければ JSON を再帰走査し、食事名に一致した物だけ採用
 *    実レスポンスを見たら KEYS に正しい名前を足すこと。
 *    確認は dumpLodgifyAddons() (メニュー「🍱 Lodgify アドオン確認」)。
 * ============================================================
 */

// ============================================================
//  1. JSON からアドオンを取り出す
// ============================================================

/**
 * booking オブジェクトからアドオンを取り出す。
 *
 * @param {Object} b Lodgify の booking (生)
 * @param {Object} [debug] 取り出し経路を記録する任意のオブジェクト
 * @return {Array<Object>} 正規化済みアドオン配列
 */
function extractLodgifyAddons(b, debug) {
  const A = (CONFIG.LODGIFY && CONFIG.LODGIFY.ADDONS) || {};
  if (!A.ENABLED) return [];
  if (!b || typeof b !== 'object') return [];

  const found = [];
  const seen = {};

  const push = (item, path, trusted) => {
    const a = normalizeLodgifyAddon(item, path, trusted);
    if (!a) return;
    const k = `${a.cleanName}|${a.qty}|${a.price}`;
    if (seen[k]) return;
    seen[k] = true;
    found.push(a);
  };

  // 1) 明示キー。名前が一致すれば中身を問わず採用する。
  const lists = findLodgifyAddonLists(b, A);
  lists.forEach(hit => {
    if (debug) (debug.paths = debug.paths || []).push(hit.path);
    hit.list.forEach(it => push(it, hit.path, true));
  });

  // 2) 明示キーで何も取れなかった場合だけ再帰走査する。
  //    誤検出を避けるため、食事名に一致した候補しか採用しない。
  if (!found.length && A.SCAN_FALLBACK) {
    const cands = scanLodgifyAddonCandidates(b, A);
    cands.forEach(c => {
      if (debug) (debug.scanned = debug.scanned || []).push(c.path);
      push(c.item, c.path, false);
    });
  }

  return found;
}

/**
 * CONFIG.LODGIFY.ADDONS.KEYS に挙げた名前の「配列プロパティ」を探す。
 * ネストしていても拾えるように深さ制限付きで潜る。
 */
function findLodgifyAddonLists(root, A) {
  const keys = (A.KEYS || []).map(k => normalizeAddonKeyName(k));
  const skip = (A.SCAN_SKIP_KEYS || []).map(k => normalizeAddonKeyName(k));
  const maxDepth = A.SCAN_MAX_DEPTH || 6;
  const out = [];

  const walk = (node, path, depth) => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }

    Object.keys(node).forEach(k => {
      const v = node[k];
      const nk = normalizeAddonKeyName(k);
      const p = path ? `${path}.${k}` : k;

      if (keys.indexOf(nk) >= 0 && Array.isArray(v) && v.length) {
        out.push({ path: p, list: v });
        return;   // アドオン配列の中は掘らない
      }
      if (skip.indexOf(nk) >= 0) return;
      walk(v, p, depth + 1);
    });
  };

  walk(root, '', 0);
  return out;
}

/**
 * アドオンらしきオブジェクトを総当たりで探す (保険の経路)。
 * 「名前らしき文字列」と「個数か金額」を両方持つ物だけを候補にする。
 */
function scanLodgifyAddonCandidates(root, A) {
  const skip = (A.SCAN_SKIP_KEYS || []).map(k => normalizeAddonKeyName(k));
  const maxDepth = A.SCAN_MAX_DEPTH || 6;
  const out = [];

  const walk = (node, path, depth) => {
    if (depth > maxDepth || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (looksLikeAddonObject(v, A)) out.push({ path: `${path}[${i}]`, item: v });
        walk(v, `${path}[${i}]`, depth + 1);
      });
      return;
    }

    Object.keys(node).forEach(k => {
      const nk = normalizeAddonKeyName(k);
      if (skip.indexOf(nk) >= 0) return;
      walk(node[k], path ? `${path}.${k}` : k, depth + 1);
    });
  };

  walk(root, '', 0);
  return out;
}

/** "Add-Ons" / "add_ons" / "addOns" を同じ名前として扱う */
function normalizeAddonKeyName(k) {
  return String(k == null ? '' : k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeAddonObject(v, A) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const hasName = (A.NAME_KEYS || []).some(k => {
    const x = pickAddonField(v, [k]);
    return typeof x === 'string' && x.trim() !== '';
  });
  if (!hasName) return false;
  const hasNum = (A.QTY_KEYS || []).concat(A.PRICE_KEYS || []).some(k => {
    const x = pickAddonField(v, [k]);
    return x !== '' && x !== null && x !== undefined && !isNaN(Number(x));
  });
  return hasNum;
}

/** 候補キー名で値を引く (大文字小文字・区切り文字を無視) */
function pickAddonField(obj, candidates) {
  if (!obj || typeof obj !== 'object') return '';
  const want = candidates.map(c => normalizeAddonKeyName(c));
  for (const k in obj) {
    if (want.indexOf(normalizeAddonKeyName(k)) < 0) continue;
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    return v;
  }
  return '';
}

/**
 * アドオン1件を正規化する。
 *
 * @param {Object|string} item
 * @param {string} path  見つけた場所 (診断用)
 * @param {boolean} trusted 明示キー由来か。false の場合は
 *                          食事と判定できた物しか採用しない。
 * @return {Object|null}
 */
function normalizeLodgifyAddon(item, path, trusted) {
  const A = (CONFIG.LODGIFY && CONFIG.LODGIFY.ADDONS) || {};

  let name = '', qty = 0, price = 0;
  if (typeof item === 'string' || typeof item === 'number') {
    name = String(item);
  } else if (item && typeof item === 'object') {
    name  = String(pickAddonField(item, A.NAME_KEYS  || []) || '').trim();
    qty   = numOrZero(pickAddonField(item, A.QTY_KEYS   || []));
    price = numOrZero(pickAddonField(item, A.PRICE_KEYS || []));
  }
  name = String(name).trim();
  if (!name) return null;

  const cleanName = stripLodgifyAddonPrefix(name);
  const meal      = matchMealDefinition(cleanName) || matchMealDefinition(name);
  const isMeal    = !!meal || isMealishAddonName(name, A);

  // 再帰走査で拾った候補は、食事と判断できた物だけ採用する。
  if (!trusted && !isMeal) return null;

  return {
    rawName:   name,
    cleanName: cleanName || name,
    qty:       qty > 0 ? qty : 1,
    price:     price,
    portion:   parseAddonPortion(name, qty),
    isMeal:    isMeal,
    mealLabel: meal ? meal.label : '',
    mealOrder: meal && meal.order != null ? meal.order : 899,
    path:      path || '',
  };
}

/** "Dinner - Chicken Hot Pot for 3" → "Chicken Hot Pot for 3" */
function stripLodgifyAddonPrefix(name) {
  const A = (CONFIG.LODGIFY && CONFIG.LODGIFY.ADDONS) || {};
  const re = A.STRIP_PREFIX;
  let s = String(name == null ? '' : name).trim();
  if (re) s = s.replace(re, '').trim();
  return s;
}

/** CONFIG.MEALS の定義に当てる */
function matchMealDefinition(name) {
  const meals = CONFIG.MEALS || [];
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  for (const m of meals) {
    if (m.test && m.test.test(s)) return m;
  }
  return null;
}

/** CONFIG.MEALS に無い新メニューを取りこぼさないための保険 */
function isMealishAddonName(name, A) {
  const hints = (A && A.MEAL_HINTS) || [];
  const s = String(name == null ? '' : name);
  return hints.some(re => re.test(s));
}

/**
 * 人前を決める。
 *   "…for 3"  x1  → 3人前
 *   "…for 2"  x2  → 4人前
 *   人前表記なし x2 → 2人前
 */
function parseAddonPortion(name, qty) {
  const A = (CONFIG.LODGIFY && CONFIG.LODGIFY.ADDONS) || {};
  const s = toHalfWidth(name);

  let per = 0;
  for (const re of (A.PORTION_PATTERNS || [])) {
    const m = s.match(re);
    if (m) { per = Number(m[1]); break; }
  }
  if (!per) {
    const p = parsePersonCount(s);
    if (p) per = Number(p);
  }

  const q = (qty > 0) ? qty : 1;
  return (per > 0) ? per * q : q;
}

/**
 * アドオン配列 → 食事サマリ / オプションサマリ の2本立てに整形する。
 * 書式は extractMealSummary() と揃える ("Chicken Hot Pot(3人前)")。
 */
function lodgifyAddonSummaries(addons) {
  const list = addons || [];
  const mealByLabel = {};
  const opts = [];

  list.forEach(a => {
    if (a.isMeal) {
      const label = a.mealLabel || a.cleanName;
      if (!mealByLabel[label]) {
        mealByLabel[label] = { label: label, order: a.mealOrder, portion: 0, price: 0 };
      }
      mealByLabel[label].portion += a.portion;
      mealByLabel[label].price   += a.price;
      // 同じ料理で order が違う定義に当たった場合は小さい方を採る
      if (a.mealOrder < mealByLabel[label].order) mealByLabel[label].order = a.mealOrder;
    } else if (CONFIG.LODGIFY.ADDONS.NON_MEAL_TO_OPTION) {
      opts.push(a.qty > 1 ? `${a.cleanName} x${a.qty}` : a.cleanName);
    }
  });

  const meals = Object.keys(mealByLabel).map(k => mealByLabel[k]);
  meals.sort((x, y) => (x.order - y.order) || (x.label < y.label ? -1 : 1));

  const mealStr = meals.map(m => {
    let entry = `${m.label}(${m.portion}人前)`;
    if (CONFIG.MEAL_SHOW_PRICE && m.price > 0) {
      entry = `${m.label}(${m.portion}人前 ¥${Number(m.price).toLocaleString('en-US')})`;
    }
    return entry;
  }).join(', ');

  return { meal: mealStr, option: opts.join(', ') };
}

// ============================================================
//  2. LatestOptions への upsert
// ============================================================

/**
 * LatestOptions の1行が Lodgify アドオン由来かを判定し、
 * 由来ならキー情報を返す。
 *
 * 出所は K列 (フォーム原文JSON) の _source に入れている。
 * 列を増やさないのは、L列「ほなみや転記済」と M列の曜日数式を
 * ずらさないため。
 *
 * @param {Array} row LatestOptions の1行 (11列以上)
 * @return {{key:string, bookingId:string, roomRaw:string}|null}
 */
function lodgifyOptionMeta(row) {
  const C = CONFIG.COL_OPT;
  const raw = row[C.FORM_JSON - 1];
  if (!raw) return null;
  const s = String(raw);
  if (s.indexOf('"_source"') < 0) return null;   // JSON.parse を避ける速い門
  let o;
  try { o = JSON.parse(s); } catch (e) { return null; }
  if (!o || o._source !== 'lodgify') return null;
  const bookingId = String(o._booking_id == null ? '' : o._booking_id);
  const roomRaw   = String(o._room_raw   == null ? '' : o._room_raw);
  if (!bookingId) return null;
  return { key: `${bookingId}|${roomRaw}`, bookingId: bookingId, roomRaw: roomRaw };
}

/**
 * LodgifyBookings シートを読み、アドオンを持つ予約から
 * LatestOptions の行 (11列) を組み立てる。
 *
 * API を叩き直さないのは、同じバッチで syncLodgifyBookings() が
 * 既に取得済みだから。Main.gs の呼び出し順に依存する。
 *
 * @return {Array<{key:string, row:Array}>}
 */
function collectLodgifyOptionRows() {
  const C = CONFIG.COL_LDG;
  const O = CONFIG.COL_OPT;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CONFIG.SHEET.LODGIFY);
  if (!sh) return [];

  const last = sh.getLastRow();
  if (last <= 1) return [];

  const width = Math.min(CONFIG.LDG_WIDTH, sh.getLastColumn());
  if (width < C.ADDONS) {
    dlog('LodgifyBookings にアドオン列が無い。syncLodgifyBookings() を先に実行すること。');
    return [];
  }
  const vals = sh.getRange(2, 1, last - 1, width).getValues();

  const out = [];
  const skipped = { 削除済み: 0, 部屋未解決: 0, アドオン無し: 0, 日付不正: 0 };

  vals.forEach(r => {
    if (r[C.DELETED_FLAG - 1] === '削除') { skipped.削除済み++; return; }

    const bookingId = String(r[C.BOOKING_ID - 1] || '').trim().replace(/\.0+$/, '');
    if (!bookingId) return;

    let addons = [];
    const rawAddons = r[C.ADDONS - 1];
    if (rawAddons) {
      try { addons = JSON.parse(String(rawAddons)) || []; } catch (e) { addons = []; }
    }
    if (!addons.length) { skipped.アドオン無し++; return; }

    const sum = lodgifyAddonSummaries(addons);
    if (!sum.meal && !sum.option) { skipped.アドオン無し++; return; }

    const room = String(r[C.ROOM - 1] || '').trim();
    if (!room) { skipped.部屋未解決++; return; }

    const checkin = toDate(r[C.CHECKIN - 1]);
    if (!checkin || isNaN(checkin.getTime())) { skipped.日付不正++; return; }

    let roomRaw = r[C.ROOM_RAW - 1];
    if (typeof roomRaw === 'number') roomRaw = String(Math.round(roomRaw));
    roomRaw = String(roomRaw == null ? '' : roomRaw).trim().replace(/\.0+$/, '');

    // 注文日時。初回取得日時を使う (毎バッチ変わらないので行が揺れない)
    const placedAt = toDate(r[C.FIRST_SEEN - 1]) || toDate(r[C.FETCHED_AT - 1]) || checkin;

    const row = new Array(11).fill('');
    row[O.BATCH_TS - 1]      = '';           // 呼び出し側で埋める
    row[O.DELETED_FLAG - 1]  = '';
    row[O.FORM_TS - 1]       = placedAt;
    row[O.CHECKIN - 1]       = checkin;
    row[O.ROOM - 1]          = room;
    row[O.GUEST_NAME - 1]    = String(r[C.GUEST_NAME - 1] || '').trim();
    row[O.GUESTS - 1]        = numOrZero(r[C.GUESTS - 1]) || '';
    row[O.MEAL_SUMMARY - 1]  = sum.meal;
    row[O.OPT_SUMMARY - 1]   = sum.option;
    row[O.OTHER_REQ - 1]     = CONFIG.LODGIFY.ADDONS.ORIGIN_TAG || 'Lodgify予約時オプション';
    row[O.FORM_JSON - 1]     = JSON.stringify({
      _source:     'lodgify',
      _booking_id: bookingId,
      _room_raw:   roomRaw,
      addons:      addons.map(a => ({
        name:    a.rawName,
        qty:     a.qty,
        portion: a.portion,
        price:   a.price,
        meal:    a.isMeal ? (a.mealLabel || a.cleanName) : '',
      })),
    });

    out.push({ key: `${bookingId}|${roomRaw}`, row: row });
  });

  dlog(`Lodgify アドオン: 対象 ${out.length} 行 / 除外 ${JSON.stringify(skipped)}`);
  return out;
}

/**
 * Lodgify アドオンを LatestOptions に upsert する。
 *
 * ・キー = 予約ID + 部屋(生値)。lodgifyRowKey() と同じ考え方。
 * ・内容が変わっていない行は一切書かない (A列の更新日時を揺らさない)。
 * ・今回のアドオンに無くなった Lodgify 行は「削除」にする (物理削除しない)。
 * ・再び現れたら「削除」を外して復活させる。
 * ・L列 (ほなみや転記済) と M列 (曜日数式) には触らない。書くのは A〜K の11列。
 *
 * @param {Date} now バッチ基準時刻
 */
function syncLodgifyMealOptions(now) {
  const res = { inserted: 0, updated: 0, deleted: 0, revived: 0, active: 0 };
  const A = (CONFIG.LODGIFY && CONFIG.LODGIFY.ADDONS) || {};
  if (!A.ENABLED) {
    dlog('Lodgify アドオン取込 skip: CONFIG.LODGIFY.ADDONS.ENABLED = false');
    return res;
  }

  const desired = collectLodgifyOptionRows();
  const optSh = getSheet(CONFIG.SHEET.LATEST_OPT);
  const C = CONFIG.COL_OPT;

  const last = optSh.getLastRow();
  const vals = (last > 1) ? optSh.getRange(2, 1, last - 1, 11).getValues() : [];

  // 既存の Lodgify 由来行を索引化。分裂していたら生きている行を優先する。
  const idxByKey = {};
  vals.forEach((row, i) => {
    const meta = lodgifyOptionMeta(row);
    if (!meta) return;
    const prev = idxByKey[meta.key];
    if (prev === undefined) { idxByKey[meta.key] = i; return; }
    const prevDeleted = (vals[prev][C.DELETED_FLAG - 1] === '削除');
    const thisDeleted = (row[C.DELETED_FLAG - 1] === '削除');
    if (prevDeleted && !thisDeleted) idxByKey[meta.key] = i;
    else if (prevDeleted === thisDeleted) idxByKey[meta.key] = i;
  });

  const seen = {};
  const appends = [];

  desired.forEach(d => {
    seen[d.key] = true;
    const i = idxByKey[d.key];

    if (i === undefined) {
      const row = d.row.slice();
      row[C.BATCH_TS - 1] = now;
      appends.push(row);
      return;
    }

    const cur = vals[i];
    const wasDeleted = (cur[C.DELETED_FLAG - 1] === '削除');
    const changed = lodgifyOptionRowChanged(cur, d.row);

    if (!changed && !wasDeleted) { res.active++; return; }   // 書かない

    const row = d.row.slice();
    row[C.BATCH_TS - 1] = now;
    optSh.getRange(i + 2, 1, 1, 11).setValues([row]);
    vals[i] = row;
    if (wasDeleted) res.revived++;
    res.updated++;
    res.active++;
  });

  // 今回のアドオンに現れなかった Lodgify 行を論理削除する
  vals.forEach((row, i) => {
    const meta = lodgifyOptionMeta(row);
    if (!meta) return;
    if (seen[meta.key]) return;
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    optSh.getRange(i + 2, C.DELETED_FLAG).setValue('削除');
    optSh.getRange(i + 2, C.BATCH_TS).setValue(now);
    res.deleted++;
  });

  if (appends.length) {
    optSh.getRange(optSh.getLastRow() + 1, 1, appends.length, 11).setValues(appends);
    res.inserted = appends.length;
    res.active += appends.length;
  }

  dlog(`Lodgify アドオン upsert: +${res.inserted} / ~${res.updated} ` +
       `(復活 ${res.revived}) / -${res.deleted}`);
  return res;
}

/**
 * 既存行と作り直した行の内容差分を見る。
 * A列(更新日時) と B列(論理削除) は比較対象外。
 * 日付は Date 型で返るので fmtDate / fmtDateTime を通して比べる。
 */
function lodgifyOptionRowChanged(cur, next) {
  const C = CONFIG.COL_OPT;

  if (fmtDateTime(cur[C.FORM_TS - 1]) !== fmtDateTime(next[C.FORM_TS - 1])) return true;
  if (fmtDate(cur[C.CHECKIN - 1])     !== fmtDate(next[C.CHECKIN - 1]))     return true;

  const plain = [C.ROOM, C.GUEST_NAME, C.MEAL_SUMMARY, C.OPT_SUMMARY, C.OTHER_REQ, C.FORM_JSON];
  for (const col of plain) {
    if (String(cur[col - 1] || '') !== String(next[col - 1] || '')) return true;
  }
  // 人数は数値。空欄と 0 を同じ扱いにする。
  if (numOrZero(cur[C.GUESTS - 1]) !== numOrZero(next[C.GUESTS - 1])) return true;

  return false;
}

// ============================================================
//  3. 診断
// ============================================================

/**
 * 診断: 実レスポンスにアドオンがどう入っているかを確認する。
 *
 * 見るべきポイント:
 *   ・「アドオンを持つ予約」が想定件数あるか
 *   ・取り出し経路が KEYS 由来か再帰走査由来か
 *     → 再帰走査由来なら、出ているパス名を
 *        CONFIG.LODGIFY.ADDONS.KEYS に足して1) の経路に変えること
 *   ・0件なら、リスト取得のレスポンスにアドオンが含まれていない。
 *     その場合は Lodgify サポートに
 *     「GET /v2/reservations/bookings のレスポンスに
 *       アドオンを含めるパラメータはあるか」を確認する。
 */
function dumpLodgifyAddons() {
  const apiKey = getLodgifyApiKey();
  if (!apiKey) {
    Logger.log('APIキー未設定。setLodgifyApiKey("xxx") を先に実行してください。');
    return;
  }

  const items = fetchLodgifyBookings(apiKey);
  Logger.log(`=== 取得件数: ${items.length} ===`);
  if (!items.length) {
    Logger.log('0件。stayFilter / includeExternal と APIキーを確認してください。');
    return;
  }

  // どんなキーが来ているかの全体像 (アドオンの入口を探す手掛かり)
  const topKeys = {};
  items.forEach(b => Object.keys(b || {}).forEach(k => { topKeys[k] = (topKeys[k] || 0) + 1; }));
  Logger.log(`--- booking のトップレベルキー ---\n${Object.keys(topKeys).sort().join(', ')}`);

  const roomKeys = {};
  items.forEach(b => (b.rooms || []).forEach(r =>
    Object.keys(r || {}).forEach(k => { roomKeys[k] = (roomKeys[k] || 0) + 1; })));
  if (Object.keys(roomKeys).length) {
    Logger.log(`--- rooms[] のキー ---\n${Object.keys(roomKeys).sort().join(', ')}`);
  }

  let withAddons = 0;
  const viaPaths = {};

  items.forEach(b => {
    const dbg = {};
    const addons = extractLodgifyAddons(b, dbg);
    if (!addons.length) return;
    withAddons++;

    (dbg.paths || []).forEach(p => { viaPaths[`KEYS:${p}`] = (viaPaths[`KEYS:${p}`] || 0) + 1; });
    (dbg.scanned || []).forEach(p => { viaPaths[`SCAN:${p}`] = (viaPaths[`SCAN:${p}`] || 0) + 1; });

    const sum = lodgifyAddonSummaries(addons);
    Logger.log(
      `\nid=${b.id} ${fmtDate(b.arrival)}→${fmtDate(b.departure)} ` +
      `${(b.guest && b.guest.name) || '-'} status=${b.status}`
    );
    addons.forEach(a => {
      Logger.log(`   ・"${a.rawName}" → ${a.isMeal ? `食事[${a.mealLabel || a.cleanName}]` : 'オプション'} ` +
                 `個数=${a.qty} 人前=${a.portion} 金額=${a.price} (${a.path})`);
    });
    Logger.log(`   食事サマリ    : ${sum.meal || '(なし)'}`);
    Logger.log(`   オプションサマリ: ${sum.option || '(なし)'}`);
  });

  Logger.log(`\n=== アドオンを持つ予約 ${withAddons} / ${items.length} 件 ===`);
  if (!withAddons) {
    Logger.log(
      '!! アドオンが1件も取れていません。次の順に確認してください。\n' +
      ' 1. Lodgify の管理画面でアドオン付きの予約が実在するか\n' +
      '    (この診断は現在 API から返る予約しか見ません)\n' +
      ' 2. 下の「生JSONの一部」にアドオンらしき項目があるか\n' +
      '    → あれば、その配列名を CONFIG.LODGIFY.ADDONS.KEYS に足す\n' +
      ' 3. 無ければリスト取得のレスポンスにアドオンが含まれていない。\n' +
      '    Lodgify サポートに「GET /v2/reservations/bookings の\n' +
      '    レスポンスにアドオンを含めるパラメータはあるか」を問い合わせる。'
    );
    // 手掛かりとして1件だけ生JSONを出す (先頭4000字)
    Logger.log(`\n--- 生JSONの一部 (id=${items[0].id}) ---\n` +
               JSON.stringify(items[0], null, 1).substring(0, 4000));
    return;
  }

  Logger.log(`--- 取り出し経路 ---\n${JSON.stringify(viaPaths, null, 1)}`);
  const scanOnly = Object.keys(viaPaths).filter(k => k.indexOf('SCAN:') === 0);
  if (scanOnly.length) {
    Logger.log(
      '注意: 再帰走査で拾っています (食事名に一致した物だけ採用)。\n' +
      '      上のパス名の配列名を CONFIG.LODGIFY.ADDONS.KEYS に足すと、\n' +
      '      食事以外のアドオンも取りこぼさなくなります。'
    );
  }
}

/**
 * メニューから Lodgify アドオン → 食事予約表 の反映だけを実行する。
 * syncLodgifyBookings() を先に済ませておくこと。
 */
function runLodgifyAddonSyncOnly() {
  const r = syncLodgifyMealOptions(nowJst());
  Logger.log(`Lodgify アドオン: +${r.inserted} / ~${r.updated} ` +
             `(復活 ${r.revived}) / -${r.deleted} / 有効 ${r.active}`);
  Logger.log('食事列への反映は buildCleaningBoard() で行われます。');
}

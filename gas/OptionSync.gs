/**
 * ============================================================
 *  OptionSync.gs - フォーム回答取込と論理削除処理 (v2.10)
 * ============================================================
 *  ── v2.10 の要点 ──────────────────────────────────────────
 *   ・バッチの最後に backfillOptionGuests() を呼び、
 *     G列(人数)の空欄を Lodgify → 食事推定 の順で埋める。
 *     現行フォームには人数設問が無いため、これが無いと
 *     食事予約表の人数が永久に空欄のままになる。
 *   ・parsePersonCount / parsePrice を全角数字対応にした。
 *     実データに "１人前" 表記があり、半角前提の正規表現が
 *     マッチせず人数が落ちていた。
 *
 *  v2.7:
 *   ・LatestOptions を宿泊日(D列)昇順で並べ替える sortOptionsByCheckin()。
 *     - ソート範囲は 12列。11列だけ並べ替えると手動更新の
 *       「ほなみや転記済」(L列) が元の行位置に取り残される。
 *     - M列「曜日」は =WEEKDAY(D2,2) の相対参照数式なので範囲に含めない。
 *
 *  v2.5:
 *   ・重複見出し列対策として buildHeaderMap は「空では上書きしない」方式。
 *   ・食事サマリは CONFIG.MEALS の先頭一致(^)で判定 (遺物列を自動除外)。
 *   ・ほなみや転記済 (12列目) はバッチで値を書き換えない。
 * ============================================================
 */

function syncOptions(now, prevProcessedAt, disappeared) {
  const optSh = getSheet(CONFIG.SHEET.LATEST_OPT);

  const appended = appendNewFormResponses(optSh, now, prevProcessedAt);
  dlog(`Appended from form: ${appended.length} rows`);

  const cancelMarked = markCancelledByDisappearance(optSh, now, disappeared);
  dlog(`Marked as cancelled: ${cancelMarked.length} rows`);

  const resubmitMarked = markOlderAsResubmitted(optSh, now);
  dlog(`Marked as resubmitted (old rows deleted): ${resubmitMarked.length} rows`);

  // 並べ替えは touched 読み取りの前に行う (rowIndex を確定させるため)
  sortOptionsByCheckin(optSh);

  // ★人数の補完。並べ替え後に行うので行位置がずれない。
  //   Lodgify 取得より後に呼ばれる必要がある (Main.gs の順序に注意)。
  try {
    backfillOptionGuests(optSh);
  } catch (e) {
    Logger.log(`人数の補完に失敗 (処理は続行): ${e.stack || e}`);
  }

  const touched = readTouchedRows(optSh, now);
  return touched;
}

/**
 * LatestOptions を宿泊日昇順で並べ替える。
 *
 * 並べ替えキー:
 *   1. 宿泊日 (D列)         昇順
 *   2. 部屋 (E列)           昇順  … 同日は 1F → 2F
 *   3. フォーム送信日時 (C列) 昇順  … 同日同室は送信が古い順 (再提出が下)
 *
 * 注意:
 *   ・範囲は A:L の12列。11列だけだと手動チェックの「ほなみや転記済」が
 *     行から切り離されてしまう。
 *   ・M列「曜日」(=WEEKDAY(D2,2)) は範囲に含めない。相対参照なので
 *     行位置が変わっても常に自分の行の宿泊日を見る。
 *   ・条件付き書式は範囲指定なので並べ替えの影響を受けない。
 */
function sortOptionsByCheckin(optSh) {
  const last = optSh.getLastRow();
  if (last <= 2) {
    dlog('Sort skipped: less than 2 data rows.');
    return;
  }

  // 直前の setValue をシートに確定させてから並べ替える
  SpreadsheetApp.flush();

  const C = CONFIG.COL_OPT;
  optSh.getRange(2, 1, last - 1, 12).sort([
    { column: C.CHECKIN, ascending: true },
    { column: C.ROOM,    ascending: true },
    { column: C.FORM_TS, ascending: true },
  ]);

  SpreadsheetApp.flush();
  dlog(`Sorted LatestOptions by checkin asc (${last - 1} rows).`);
}

function appendNewFormResponses(optSh, now, prevProcessedAt) {
  const formSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET.FORM_RAW);
  if (!formSh) {
    dlog(`Form sheet not found: ${CONFIG.SHEET.FORM_RAW}. Skipping form sync.`);
    return [];
  }
  const last = formSh.getLastRow();
  if (last <= 1) return [];
  const lastCol = formSh.getLastColumn();
  const vals = formSh.getRange(2, 1, last - 1, lastCol).getValues();
  const headers = formSh.getRange(1, 1, 1, lastCol).getValues()[0];

  const appended = [];
  for (const row of vals) {
    const ts = row[0];
    if (!ts) continue;
    const tsDate = toDate(ts);
    if (!tsDate) continue;
    if (tsDate <= prevProcessedAt) continue;

    const optRow = buildOptionRow(row, headers, now, tsDate);
    if (!optRow) continue;
    appended.push(optRow);
  }

  if (appended.length > 0) {
    const startRow = optSh.getLastRow() + 1;
    // 書き込みは11列分 (HONAMIYA_DONE と 曜日数式は手動管理のため触らない)
    optSh.getRange(startRow, 1, appended.length, 11).setValues(appended.map(r => r.slice(0, 11)));
  }
  return appended;
}

/**
 * フォーム1回答分の {trim(ヘッダー): 値} マップを構築する。
 *
 * 重要: このシートには改訂で増えた「同じトリム見出し」の列が複数ある
 *   (例: Name under the reservation が 10列目と26列目, Room が 12列目と29列目)。
 * 単純に最後の列で上書きすると、後ろの空列が前の実値を消してしまう。
 * → 「最初に現れた非空の値」を採用し、空では上書きしない。
 *
 * 新設問「If it is WEDNESDAY & THURSDAY...」はフォーム側の見出し末尾に
 * 半角スペースが入っているが、ここで trim してキー化するため
 * CONFIG.OPTIONS 側にスペースを書く必要はない。
 */
function buildHeaderMap(formHeaders, formRow) {
  const h2v = {};
  formHeaders.forEach((h, i) => {
    const key = String(h).trim();
    if (!key) return;
    const val = formRow[i];
    const hasVal = (val !== '' && val !== null && val !== undefined);

    if (!(key in h2v)) {
      h2v[key] = hasVal ? val : '';
    } else {
      const cur = h2v[key];
      const curEmpty = (cur === '' || cur === null || cur === undefined);
      if (curEmpty && hasVal) h2v[key] = val;  // 空→非空 への昇格のみ許可
    }
  });
  return h2v;
}

function buildOptionRow(formRow, formHeaders, batchTs, formTs) {
  const C = CONFIG.COL_OPT;
  const row = new Array(11).fill('');

  const h2v = buildHeaderMap(formHeaders, formRow);

  // 管理列
  row[C.BATCH_TS - 1]     = batchTs;
  row[C.DELETED_FLAG - 1] = '';
  row[C.FORM_TS - 1]      = formTs;

  // キー列
  const checkin = pickValue(h2v, ['Check-in date', 'Check-in', 'チェックイン日', 'Checkin']);
  const checkinDate = checkin ? toDate(checkin) : '';
  row[C.CHECKIN - 1] = checkinDate;

  const roomRaw = pickValue(h2v, ['Room', '部屋']);
  row[C.ROOM - 1] = normalizeRoom(roomRaw);

  row[C.GUEST_NAME - 1] = pickValue(h2v, [
    'Name under the reservation',
    'Name under the Booking.com reservation',
    '宿泊者名',
    'Name',
  ]);

  // 人数: 現行フォームに設問が無いため通常は空欄。
  //       空欄のままなら backfillOptionGuests() が後で Lodgify から埋める。
  const guestsRaw = pickValue(h2v, ['Number of guests', 'Guests', '人数']);
  const guestsNum = numOrZero(guestsRaw);
  row[C.GUESTS - 1] = guestsNum > 0 ? guestsNum : '';

  // 食事サマリ
  const meal = extractMealSummary(h2v);
  const mealNote = pickValue(h2v, [
    'Please fill in any additional requests, such as ordering an odd number of people or restrictions on ingredients',
    'Please fill in any additional requests',
  ]);
  row[C.MEAL_SUMMARY - 1] = mealNote
    ? (meal ? `${meal} ⚠ ${mealNote}` : `⚠ ${mealNote}`)
    : meal;

  // オプションサマリ (泉屋送迎を含む。曜日判定に宿泊日を渡す)
  const opt = extractOptionSummary(h2v, checkinDate);
  const taxiNote = pickValue(h2v, [
    'Please describe any other protruding features',
  ]);
  row[C.OPT_SUMMARY - 1] = taxiNote
    ? (opt ? `${opt} ⚠ ${taxiNote}` : `⚠ ${taxiNote}`)
    : opt;

  // その他要望
  row[C.OTHER_REQ - 1] = pickValue(h2v, [
    'Please write if you have requests and questions below',
    'Please write if you have requests and questions below.',
  ]);

  // フォーム原文 JSON (非空のみ採用。重複見出しは最初の非空を保持)
  const jsonObj = {};
  formHeaders.forEach((h, i) => {
    const key = String(h).trim();
    if (!key) return;
    const v = formRow[i];
    if (v === '' || v === null || v === undefined) return;
    if (key in jsonObj) return;
    jsonObj[key] = (v instanceof Date) ? v.toISOString() : v;
  });
  row[C.FORM_JSON - 1] = JSON.stringify(jsonObj);

  // キー項目揃ってなければスキップ
  if (!row[C.CHECKIN - 1] || !row[C.ROOM - 1] || !row[C.GUEST_NAME - 1]) {
    return null;
  }

  return row;
}

/**
 * 食事サマリを生成する (現行フォーム対応)
 */
function extractMealSummary(h2v) {
  const meals = CONFIG.MEALS || [];
  const found = [];

  for (const key in h2v) {
    const v = h2v[key];
    if (v === '' || v === null || v === undefined) continue;

    const idx = meals.findIndex(m => m.test.test(key));
    if (idx < 0) continue;
    const meal = meals[idx];

    const n = parsePersonCount(v);
    const portion = n ? `${n}人前` : String(v).trim();
    let entry = `${meal.label}(${portion})`;

    if (CONFIG.MEAL_SHOW_PRICE) {
      const price = parsePrice(v);
      if (price) entry = `${meal.label}(${portion} ${price})`;
    }

    found.push({ order: (meal.order != null ? meal.order : 999), entry: entry });
  }

  found.sort((a, b) => a.order - b.order);
  return found.map(f => f.entry).join(', ');
}

/**
 * "3 person - ¥8,000" などから人数(整数文字列)を抽出。
 * 全角数字 ("３ person") も拾う。
 */
function parsePersonCount(value) {
  const m = toHalfWidth(value).match(/(\d+)\s*(?:persons?|people|名|人)/i);
  return m ? m[1] : '';
}

/**
 * "3 person - ¥8,000" などから価格表記(¥8,000)を抽出
 */
function parsePrice(value) {
  // ￥ (全角円記号) は U+FFE5 で toHalfWidth の変換範囲外なので両方残す
  const m = toHalfWidth(value).match(/[¥￥]\s*[\d,]+/);
  return m ? m[0].replace(/\s/g, '') : '';
}

/**
 * オプションサマリを生成する。
 *
 * CONFIG.OPTIONS の宣言表を order 昇順に走査し、
 * Yes と答えられた設問だけを連結する。
 * 例) "泉屋送迎, 荷物預け x2, タクシー (→Nagoya Station)"
 *
 * validWeekdays が指定されたオプション (= 泉屋送迎: 水木のみ) は、
 * 宿泊日の曜日が対象外なら警告を付ける。
 * 例) "泉屋送迎⚠曜日要確認(月)"
 *
 * @param {Object} h2v         trim済みヘッダー → 値 のマップ
 * @param {Date|string} checkinDate  宿泊日 (= 夕食日)。無ければ曜日判定はスキップ
 * @return {string}
 */
function extractOptionSummary(h2v, checkinDate) {
  const defs = (CONFIG.OPTIONS || []).slice().sort((a, b) => {
    const ao = (a.order != null) ? a.order : 999;
    const bo = (b.order != null) ? b.order : 999;
    return ao - bo;
  });

  const parts = [];

  for (const def of defs) {
    const ans = pickValue(h2v, def.ask || []);
    if (yesNo(ans) !== 'Yes') continue;

    let entry = def.label;

    // 個数
    if (def.count && def.count.length) {
      const n = pickValue(h2v, def.count);
      if (n !== '' && n !== null && n !== undefined) {
        entry += ` x${String(n).trim()}`;
      }
    }

    // 補足テキスト (行き先など)
    if (def.detail && def.detail.length) {
      const d = pickValue(h2v, def.detail);
      if (d) {
        const max = (def.detailMax != null) ? def.detailMax : 20;
        const prefix = def.detailPrefix || '';
        entry += ` (${prefix}${String(d).trim().substring(0, max)})`;
      }
    }

    // 提供曜日の制限チェック (泉屋送迎は水・木のみ)
    if (def.validWeekdays && def.validWeekdays.length) {
      const wd = isoWeekday(checkinDate);
      if (wd && def.validWeekdays.indexOf(wd) < 0) {
        entry += `⚠${def.warnLabel || '曜日要確認'}(${weekdayJa(wd)})`;
        dlog(`Option "${def.id}" answered Yes but checkin weekday is ${weekdayJa(wd)}.`);
      }
    }

    parts.push(entry);
  }

  return parts.join(', ');
}

/**
 * 候補ヘッダーから最初の非空値を取得。
 * 完全一致を優先し、無ければ部分一致(小文字)でフォールバック。
 */
function pickValue(h2v, candidates) {
  for (const c of candidates) {
    if (h2v[c] !== undefined && h2v[c] !== '') return h2v[c];
  }
  for (const key in h2v) {
    for (const c of candidates) {
      if (key.toLowerCase().includes(c.toLowerCase())) {
        if (h2v[key] !== '') return h2v[key];
      }
    }
  }
  return '';
}

function normalizeRoom(raw) {
  if (!raw) return '';
  const s = String(raw).toLowerCase();
  if (s.includes('1st') || s.includes('1f') || s.includes('first') ||
      s.includes('一階') || s.includes('1階') ||
      s.includes('japanese') || s.includes('historical')) return '1F';
  if (s.includes('2nd') || s.includes('2f') || s.includes('second') ||
      s.includes('二階') || s.includes('2階') ||
      s.includes('superior family') || s.includes('modern')) return '2F';
  return '';
}

function yesNo(raw) {
  if (!raw) return '';
  const s = String(raw).toLowerCase().trim();
  if (s === 'yes' || s === 'y' || s === 'はい') return 'Yes';
  if (s === 'no' || s === 'n' || s === 'いいえ') return 'No';
  return '';
}

function markCancelledByDisappearance(optSh, now, disappeared) {
  if (!disappeared || disappeared.length === 0) return [];
  const disKeys = new Set(disappeared.map(d => `${fmtDate(d.checkin)}|${d.room}`));

  const last = optSh.getLastRow();
  if (last <= 1) return [];
  const C = CONFIG.COL_OPT;
  const vals = optSh.getRange(2, 1, last - 1, 11).getValues();

  const marked = [];
  vals.forEach((row, idx) => {
    const deletedFlag = row[C.DELETED_FLAG - 1];
    if (deletedFlag === '削除') return;
    const k = `${fmtDate(row[C.CHECKIN - 1])}|${row[C.ROOM - 1]}`;
    if (disKeys.has(k)) {
      const rowIdx = idx + 2;
      optSh.getRange(rowIdx, C.DELETED_FLAG).setValue('削除');
      optSh.getRange(rowIdx, C.BATCH_TS).setValue(now);
      marked.push(rowIdx);
    }
  });
  return marked;
}

function markOlderAsResubmitted(optSh, now) {
  const last = optSh.getLastRow();
  if (last <= 1) return [];
  const C = CONFIG.COL_OPT;
  const vals = optSh.getRange(2, 1, last - 1, 11).getValues();

  const nowMs = now.getTime();
  const newKeys = new Set();
  vals.forEach(row => {
    const batchTs = row[C.BATCH_TS - 1];
    // 今回のバッチで書かれた行か (ミリ秒の丸め対策で許容差付き比較)
    if (!sameTs(batchTs, nowMs)) return;
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    const k = optKey(row);
    if (k) newKeys.add(k);
  });

  const marked = [];
  vals.forEach((row, idx) => {
    const batchTs = row[C.BATCH_TS - 1];
    if (!(batchTs instanceof Date)) return;
    // 今回バッチ分は対象外。それより古い行のみ処理する。
    if (sameTs(batchTs, nowMs)) return;
    if (batchTs.getTime() > nowMs) return;
    if (row[C.DELETED_FLAG - 1] === '削除') return;
    const k = optKey(row);
    if (!k) return;
    if (newKeys.has(k)) {
      const rowIdx = idx + 2;
      optSh.getRange(rowIdx, C.DELETED_FLAG).setValue('削除');
      optSh.getRange(rowIdx, C.BATCH_TS).setValue(now);
      marked.push(rowIdx);
    }
  });
  return marked;
}

function optKey(row) {
  const C = CONFIG.COL_OPT;
  const d = fmtDate(row[C.CHECKIN - 1]);
  const r = row[C.ROOM - 1];
  const n = (row[C.GUEST_NAME - 1] || '').toString().trim().toLowerCase();
  if (!d || !r || !n) return '';
  return `${d}|${r}|${n}`;
}

function readTouchedRows(optSh, now) {
  const last = optSh.getLastRow();
  if (last <= 1) return [];
  const C = CONFIG.COL_OPT;
  const vals = optSh.getRange(2, 1, last - 1, 11).getValues();
  const nowMs = now.getTime();

  const touched = [];
  vals.forEach((row, idx) => {
    const ts = row[C.BATCH_TS - 1];
    if (!sameTs(ts, nowMs)) return;
    touched.push({
      rowIndex: idx + 2,
      row:      row,
    });
  });
  return touched;
}

/**
 * 動作確認用: FormResponses の最終行を1件だけ変換してログ出力する。
 * シートには一切書き込まないので、フォーム改訂のたびに気軽に叩ける。
 */
function testBuildLastOptionRow() {
  const formSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET.FORM_RAW);
  if (!formSh) throw new Error(`Sheet not found: ${CONFIG.SHEET.FORM_RAW}`);
  const last = formSh.getLastRow();
  if (last <= 1) {
    Logger.log('No form responses.');
    return;
  }
  const lastCol = formSh.getLastColumn();
  const headers = formSh.getRange(1, 1, 1, lastCol).getValues()[0];
  const row = formSh.getRange(last, 1, 1, lastCol).getValues()[0];

  const built = buildOptionRow(row, headers, nowJst(), toDate(row[0]));
  if (!built) {
    Logger.log('buildOptionRow returned null (missing checkin / room / name).');
    return;
  }
  const C = CONFIG.COL_OPT;
  Logger.log(`宿泊日        : ${fmtDate(built[C.CHECKIN - 1])} (${weekdayJa(isoWeekday(built[C.CHECKIN - 1]))})`);
  Logger.log(`部屋          : ${built[C.ROOM - 1]}`);
  Logger.log(`宿泊者名      : ${built[C.GUEST_NAME - 1]}`);
  Logger.log(`人数          : ${built[C.GUESTS - 1] || '(空欄 → Lodgifyから補完される)'}`);
  Logger.log(`食事サマリ    : ${built[C.MEAL_SUMMARY - 1]}`);
  Logger.log(`オプションサマリ: ${built[C.OPT_SUMMARY - 1]}`);
  Logger.log(`その他要望    : ${built[C.OTHER_REQ - 1]}`);
}

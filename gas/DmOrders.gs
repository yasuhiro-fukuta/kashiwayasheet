/**
 * ============================================================
 *  DmOrders.gs — DMで受けた食事注文を注文確認票と突き合わせる  v1.00
 * ============================================================
 *  WhatsApp・Lodgify・メール等のDMで受けた食事注文は、Googleフォームや
 *  Lodgifyオプションを通らないので食事予約表に載らず、ほなみやへの
 *  発注から漏れる (2026-10-16 Gareth様: 7/29にDMで受けた夕食が当日
 *  用意されていなかった)。
 *
 *  そこで本体のブックに「DMからの食事注文」シートを置き、人が1行ずつ
 *  書く。注記処理 (毎時バッチの最後, OrderAnnotate.gs) で注文確認票と
 *  突き合わせ、食い違いを 日付セルのメモ に書き添える。
 *
 *  ★このシートの値をシステムが書き換えることはない。
 *    シートが無いときに作り、最初の内容を1回だけ入れるだけ。
 *
 *  突き合わせのルール (食事日 × 部屋 × 品目, 人数で比べる)
 *    状態=有効 … 注文確認票の人数が DM より少なければ「不足」
 *    状態=取消 … 注文確認票の人数が 有効分 より多ければ「外してください」
 *    それ以外 (未確定・対応済 など) … 突き合わせない
 *  過ぎた日は見ない。
 *
 *  入口:
 *    setupDmOrderSheet()   … シートを作る (既にあれば何もしない)
 *    previewDmOrderNotes() … 注記の下見 (previewOrderSheetNotes と同じ)
 * ============================================================
 */

/** シートを作る。既にあれば何もしない。 */
function setupDmOrderSheet() {
  const sh = ensureDmOrderSheet_();
  Logger.log(`「${sh.getName()}」 ${Math.max(0, sh.getLastRow() - 2)}行`);
  return sh.getName();
}

/** 注記の下見。書き込みはしない。 */
function previewDmOrderNotes(ym) {
  return previewOrderSheetNotes(ym);
}

/**
 * シートを用意する。無ければ作って、最初の内容を入れる。
 *  1行目 … 注意書き
 *  2行目 … 見出し
 *  3行目〜 … 注文
 */
function ensureDmOrderSheet_() {
  const D = CONFIG.DM_ORDERS;
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(D.SHEET_NAME);
  if (sh) return sh;

  sh = ss.insertSheet(D.SHEET_NAME);
  sh.getRange(1, 1).setValue(D.NOTICE).setFontColor('#b45309').setWrap(false);
  sh.getRange(2, 1, 1, D.HEADER.length).setValues([D.HEADER])
    .setFontWeight('bold').setBackground('#f3f4f6');
  sh.setFrozenRows(2);

  const seed = DM_ORDER_SEED_;
  if (seed.length) {
    sh.getRange(3, 1, seed.length, D.HEADER.length).setValues(seed);
  }
  sh.getRange(3, 1, Math.max(seed.length, 1) + 200, 1).setNumberFormat('yyyy/mm/dd');

  //  状態は選ぶだけにする (書き間違いで突き合わせから外れないように)
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([D.STATUS_ACTIVE, D.STATUS_CANCEL, '未確定', '対応済'], true)
    .setAllowInvalid(false).build();
  sh.getRange(3, 9, Math.max(seed.length, 1) + 200, 1).setDataValidation(rule);
  const roomRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.CLEANING.ROOMS, true).setAllowInvalid(false).build();
  sh.getRange(3, 2, Math.max(seed.length, 1) + 200, 1).setDataValidation(roomRule);

  sh.autoResizeColumns(1, D.HEADER.length);
  return sh;
}

/**
 * シートを読む。
 *  @return {Array<{date, room, name, item, label, kind, persons, time, status, row}>}
 *    label/kind が空の行は品目が読めなかったもの (注記で知らせる)。
 */
function readDmOrders_() {
  const D = CONFIG.DM_ORDERS;
  if (!D || !D.ENABLED) return [];
  const sh = ensureDmOrderSheet_();
  const last = sh.getLastRow();
  if (last < 3) return [];
  const values = sh.getRange(3, 1, last - 2, D.HEADER.length).getValues();
  return parseDmOrderRows_(values, 3);
}

/** 値の2次元配列 → 注文の配列。シートに触らないのでテストできる。 */
function parseDmOrderRows_(values, firstRow) {
  const out = [];
  values.forEach((v, i) => {
    const date = dmDateOf_(v[0]);
    const room = toHalfWidth(String(v[1] || '')).trim().toUpperCase();
    const item = String(v[3] || '').trim();
    if (!date || !room || !item) return;
    const hit = orderItemLabelOf_(item);
    const n = Number(toHalfWidth(String(v[4] || '')).replace(/[^0-9.]/g, ''));
    out.push({
      date: date,
      room: room,
      name: String(v[2] || '').trim(),
      item: item,
      label: hit.label,
      kind: hit.kind,
      persons: (isFinite(n) && n > 0) ? n : 0,
      time: String(v[5] || '').trim(),
      status: String(v[8] || '').trim(),
      row: (firstRow || 1) + i,
    });
  });
  return out;
}

/** 日付セル → 'yyyy-MM-dd'。Date でも '2026/10/19' でも読む。 */
function dmDateOf_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return fmtDate(v);
  const m = toHalfWidth(String(v)).match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${('0' + m[2]).slice(-2)}-${('0' + m[3]).slice(-2)}`;
}

/** その (日付|部屋) に有効なDM注文があるか。 */
function dmCoversKey_(dmRows, key) {
  const A = CONFIG.DM_ORDERS.STATUS_ACTIVE;
  return dmRows.some(d => d.status === A && `${d.date}|${d.room}` === key);
}

/**
 * DM注文と注文確認票を比べて、日付セルに書く文面を作る。
 *  シートに触らないのでテストできる。
 *  @param {Array} entries  scanOrderSheet().entries
 *  @param {Array} dmRows   readDmOrders_() の当月分
 *  @param {string} today   'yyyy-MM-dd'
 *  @return {Array<{date, floor, text}>}
 */
function buildDmOrderMessages_(entries, dmRows, today) {
  const D = CONFIG.DM_ORDERS;
  const byKey = {};
  dmRows.forEach(d => {
    if (d.date < today) return;
    if (d.status !== D.STATUS_ACTIVE && d.status !== D.STATUS_CANCEL) return;
    const k = `${d.date}|${d.room}`;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push(d);
  });

  const sheetByKey = {};
  entries.forEach(e => {
    const k = `${e.date}|${e.floor}`;
    if (!sheetByKey[k]) sheetByKey[k] = [];
    sheetByKey[k].push(e);
  });

  const out = [];
  Object.keys(byKey).sort().forEach(k => {
    const p = k.split('|');
    const rows = byKey[k];
    const sheet = entriesToPortions(sheetByKey[k] || []).counts;

    const want = {}, cancel = {}, names = [], unknown = [];
    rows.forEach(d => {
      if (d.name && names.indexOf(d.name) < 0) names.push(d.name);
      if (!d.label || !d.persons) {
        unknown.push(`${d.item} ${d.persons || '?'}人前 (DMシート${d.row}行目)`);
        return;
      }
      const bag = (d.status === D.STATUS_ACTIVE) ? want : cancel;
      bag[d.label] = (bag[d.label] || 0) + d.persons;
    });

    const L = [];
    Object.keys(want).sort().forEach(lb => {
      const have = sheet[lb] || 0;
      if (have >= want[lb]) return;
      L.push(`   ・${lb}  DM ${want[lb]}名 / この表 ${have}名  (${want[lb] - have}名 不足)`);
      L.push(`       →  ${portionsToSetText_(lb, want[lb])} にしてください`);
    });
    Object.keys(cancel).sort().forEach(lb => {
      const have = sheet[lb] || 0;
      const keep = want[lb] || 0;
      if (have <= keep) return;
      L.push(`   ・${lb}  DMで取消済み / この表 ${have}名`);
      L.push(keep
        ? `       →  ${portionsToSetText_(lb, keep)} に減らしてください`
        : '       →  この品目は外してください');
    });
    unknown.forEach(u => L.push(`   ・⚠品目か人数が読めません: ${u}`));
    if (!L.length) return;

    L.unshift(`⚠ DMで受けた注文と合いません  ${p[1]} ${names.join(' / ') || '(氏名なし)'}`);
    L.push('   (シート「DMからの食事注文」より。食事予約表と食い違うときはDMが正)');
    out.push({ date: p[0], floor: p[1], text: L.join('\n') });
  });
  return out;
}

//  シートを作るときに1回だけ入れる内容 (2026-10-16 の洗い出し結果)。
//  ★作った後はシートが正。ここを直してもシートには反映されない。
//  列: 食事日, 部屋, ゲスト名, 品目, 人前, 時刻, 受けた経路, DMの日付, 状態, メモ
const DM_ORDER_SEED_ = [
  ['2026/10/16', '1F', "Gareth O'Neill", '和牛BBQ', 2, '18:30', 'Lodgify', '2026/07/29', '対応済',
   '7/29にDMで受付。ボード未反映で柏屋では用意できず、近所の別シェフに依頼・食事代は柏屋負担（10/16 社長判断）'],
  ['2026/10/18', '2F', 'Gabriel Shaya', '鶏鍋', 4, '', 'Lodgify', '2026/10/05', '取消',
   'Yannick様の鶏鍋4人前がこの行に誤って入っていた。Gabriel様の夕食注文はなし'],
  ['2026/10/19', '1F', 'Yannick Wawrzyniak', '鶏鍋', 4, '', 'Lodgify', '2026/10/05', '有効',
   '10/18夜は外食。鶏鍋は10/19夜に移すと約束'],
  ['2026/10/19', '2F', 'Michael Mogan', '豚しゃぶ', 2, '', 'Lodgify', '', '有効', ''],
  ['2026/10/19', '2F', 'Michael Mogan', '朝食', 2, '', 'Lodgify', '', '取消',
   '朝食は10/21朝のみ（10/20朝はなし）'],
  ['2026/10/20', '2F', 'Michael Mogan', 'すき焼き', 2, '', 'Lodgify', '', '有効',
   '10/20夜は和牛すき焼き（しゃぶではない）'],
  ['2026/10/20', '2F', 'Michael Mogan', '豚しゃぶ', 2, '', 'Lodgify', '', '取消', '10/20はすき焼きに変更'],
  ['2026/10/20', '2F', 'Michael Mogan', '朝食', 2, '', 'Lodgify', '', '有効', '10/21朝の分'],
  ['2026/10/21', '1F', 'matteo nepa', 'すき焼き', 2, '', 'Lodgify', '', '未確定',
   '和牛1人前不可のためヴィーガン鍋2人前を提案中（フォーム再送待ち）。夕食代は宿泊代と相殺'],
  ['2026/10/26', '1F', 'Levi Wong', 'すき焼き', 1, '', 'Lodgify', '2026/01/14', '未確定',
   '1/14にDMで和牛すき焼き1人前を受付。和牛1人前不可と食い違い、出し方を社長確認中'],
  ['2026/10/26', '2F', 'Fredrik Averpil', '豚しゃぶ', 4, '', 'Lodgify', '', '有効', '1泊目はしゃぶしゃぶ'],
  ['2026/10/26', '2F', 'Fredrik Averpil', 'すき焼き', 4, '', 'Lodgify', '', '取消', 'すき焼きは2泊目'],
  ['2026/10/26', '2F', 'Fredrik Averpil', '朝食', 2, '', 'Lodgify', '', '有効', '2名×2朝'],
  ['2026/10/27', '2F', 'Fredrik Averpil', 'すき焼き', 4, '', 'Lodgify', '', '有効', '2泊目は和牛すき焼き'],
  ['2026/10/27', '2F', 'Fredrik Averpil', '豚しゃぶ', 4, '', 'Lodgify', '', '取消', 'しゃぶしゃぶは1泊目'],
  ['2026/10/27', '2F', 'Fredrik Averpil', '朝食', 2, '', 'Lodgify', '', '有効', '2名×2朝'],
];

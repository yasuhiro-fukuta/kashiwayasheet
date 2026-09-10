/**
 * ============================================================
 *  CheckinForm.gs - Check-In Form (宿泊者名簿) の取込 (v2.10.3)
 * ============================================================
 *  ★これは食事・オプションの注文フォーム (FormResponses / LatestOptions)
 *    とは別物。別スプレッドシートに回答が溜まる。
 *
 *    FormResponses  … 食事の注文、泉屋送迎・荷物・タクシー等のオプション
 *    Check-In Form  … 代表者氏名 / 住所 / 職業 / 電話番号 (宿泊者名簿)
 *
 *    v2.10.2 で「Check-In Form 未提出なら E列を赤字」を実装した際、
 *    誤って LatestOptions (= 食事フォーム) を見ていた。
 *    食事を注文していれば未提出でも提出済み扱いになってしまうため、
 *    参照先をこちらに直した。
 *
 *  突合キー: (Check-in Date, Room Name) → 清掃ボードの (宿泊日, 部屋)
 *    Room Name は "1st floor" / "2nd floor" で入ってくるので
 *    normalizeRoom() がそのまま 1F / 2F に解決できる。
 *
 *  列は「見出し名」で探す。フォームに設問を足して列がずれても
 *  壊れないようにするため、位置指定はしない。
 * ============================================================
 */

/**
 * Check-In Form の回答を読み、(宿泊日|部屋) → 提出情報 のマップを返す。
 *
 * @return {Object|null}
 *   マップ … 読めた場合 (空でも {} を返す)
 *   null  … スプレッドシートを開けない/設定が無い等で「判定不能」。
 *           この場合は未提出の警告を一切出さない (誤検知を防ぐため)。
 */
function loadCheckinFormEntries() {
  const F = CONFIG.CHECKIN_FORM || {};

  if (!F.SPREADSHEET_ID) {
    Logger.log('CHECKIN_FORM.SPREADSHEET_ID が未設定です。未提出の判定をスキップします。');
    return null;
  }

  let sh;
  try {
    const ss = SpreadsheetApp.openById(F.SPREADSHEET_ID);
    sh = F.SHEET_NAME ? ss.getSheetByName(F.SHEET_NAME) : null;
    if (!sh) sh = ss.getSheets()[0];
  } catch (e) {
    Logger.log(`Check-In Form を開けません (未提出の判定をスキップ): ${e}`);
    return null;
  }
  if (!sh) return null;

  const last = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (last <= 1 || lastCol < 1) return {};

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h == null ? '' : h).trim());

  const iCheckin = findHeaderIndex(headers, F.HEADER_CHECKIN);
  const iRoom    = findHeaderIndex(headers, F.HEADER_ROOM);
  const iName    = findHeaderIndex(headers, F.HEADER_NAME);

  if (iCheckin < 0 || iRoom < 0) {
    Logger.log('Check-In Form の見出しが見つかりません (未提出の判定をスキップ)。');
    Logger.log(`  探した見出し: 宿泊日=${JSON.stringify(F.HEADER_CHECKIN)} / ` +
               `部屋=${JSON.stringify(F.HEADER_ROOM)}`);
    Logger.log(`  実際の見出し: ${JSON.stringify(headers)}`);
    return null;
  }

  const vals = sh.getRange(2, 1, last - 1, lastCol).getValues();
  const map = {};
  let skipped = 0;

  vals.forEach(row => {
    const d = fmtDate(row[iCheckin]);
    const room = normalizeRoom(row[iRoom]);
    if (!d || !room) { if (row[iCheckin] || row[iRoom]) skipped++; return; }

    const ts = toDate(row[0]);
    const tsMs = (ts && !isNaN(ts.getTime())) ? ts.getTime() : 0;
    const key = `${d}|${room}`;

    // 同じ日・同じ部屋で複数回出されていたら新しい方を残す
    if (!map[key] || tsMs >= map[key].tsMs) {
      map[key] = {
        tsMs: tsMs,
        submittedAt: ts,
        name: (iName >= 0) ? String(row[iName] || '').trim() : '',
        roomRaw: String(row[iRoom] || '').trim(),
      };
    }
  });

  dlog(`Check-In Form: ${Object.keys(map).length} 件を読み込み ` +
       `(日付/部屋が読めず除外 ${skipped} 件)`);
  return map;
}

/**
 * 見出し候補から列番号(0始まり)を探す。
 * 完全一致 → 部分一致(小文字) の順。見つからなければ -1。
 */
function findHeaderIndex(headers, candidates) {
  const cands = candidates || [];
  for (let c = 0; c < cands.length; c++) {
    const i = headers.indexOf(cands[c]);
    if (i >= 0) return i;
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase();
    if (!h) continue;
    for (let c = 0; c < cands.length; c++) {
      if (h.indexOf(String(cands[c]).toLowerCase()) >= 0) return i;
    }
  }
  return -1;
}

/**
 * 各滞在に Check-In Form の提出状況を書き込む。
 *
 *   s.formDone      true=提出済み / false=未提出 / null=判定不能
 *   s.formName      フォームに書かれた代表者名 (表記ゆれの確認用)
 *   s.formSubmitted 提出日時
 *
 * 連泊の場合、フォームはチェックイン日で出されるのが原則だが、
 * 中日の日付で出す人もいるため滞在期間内も見る。
 */
function applyCheckinFormStatus(stays, entries) {
  const map = (entries === undefined) ? loadCheckinFormEntries() : entries;

  if (map === null) {
    stays.forEach(s => { s.formDone = null; });   // 判定不能
    return null;
  }

  let done = 0;
  stays.forEach(s => {
    let hit = map[`${s.checkin}|${s.room}`];

    if (!hit) {
      let d = addDaysStr(s.checkin, 1);
      let guard = 0;
      while (d < s.checkout && guard++ < 400) {
        if (map[`${d}|${s.room}`]) { hit = map[`${d}|${s.room}`]; break; }
        d = addDaysStr(d, 1);
      }
    }

    s.formDone = !!hit;
    if (hit) {
      done++;
      s.formName = hit.name;
      s.formSubmitted = hit.submittedAt;
    }
  });

  dlog(`Check-In Form 提出済み: ${done} / ${stays.length} 滞在`);
  return map;
}

/**
 * 診断: Check-In Form が実際に読めているかを確認する。
 * 「赤字が付かない / 付きすぎる」ときは、まずこれを実行する。
 */
function dumpCheckinForm() {
  const F = CONFIG.CHECKIN_FORM || {};
  Logger.log('=== Check-In Form 読み込み確認 ===');
  Logger.log(`SPREADSHEET_ID: ${F.SPREADSHEET_ID || '(未設定)'}`);
  Logger.log(`SHEET_NAME    : ${F.SHEET_NAME || '(先頭シート)'}`);

  const map = loadCheckinFormEntries();
  if (map === null) {
    Logger.log('!! 読み込めませんでした。上のエラー内容を確認してください。');
    Logger.log('   ・スプレッドシートIDが正しいか');
    Logger.log('   ・このスクリプトの実行者がそのファイルを開けるか');
    return;
  }

  const keys = Object.keys(map).sort();
  Logger.log(`読み込めた回答: ${keys.length} 件`);
  Logger.log('--- 直近20件 ---');
  keys.slice(-20).forEach(k => {
    const v = map[k];
    Logger.log(`  ${k}  ${v.name || '(氏名なし)'}  提出=${fmtDateTime(v.submittedAt) || '-'} ` +
               `(部屋の生値="${v.roomRaw}")`);
  });

  // 清掃ボードの滞在と突合してみる
  const bookings = loadLodgifyBookings();
  const stays = readStaysFromReservations();
  mergeLodgifyStays(stays, bookings);
  applyLodgifyPeople(stays, bookings);
  applyCheckinFormStatus(stays, map);

  const today = fmtDate(todayJst());
  const recent = stays.filter(s => s.checkin <= today && s.checkin >= addDaysStr(today, -14))
                      .sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
  Logger.log(`\n--- 直近14日のチェックイン ${recent.length} 件の提出状況 ---`);
  recent.forEach(s => {
    Logger.log(`  ${s.checkin} ${s.room} ${(s.name || '(氏名未取得)')} → ` +
      (s.formDone ? `提出済み (フォーム上の氏名: ${s.formName || '-'})` : '★未提出'));
  });
}

/**
 * ============================================================
 *  「なぜこのセルが赤いのか」を特定する (v2.10.4)
 * ============================================================
 *  E列の赤字には出どころが3通りある。見た目では区別できないので、
 *  実際のセルとルールを読んで切り分ける。
 *
 *    (1) このスクリプトが直接付けた文字色 (applyCheckinFormAlerts)
 *    (2) 条件付き書式で付いた文字色 (人が手で作ったルールなど)
 *    (3) 人が手で付けた文字色、または古い版が付けたまま残っているもの
 *
 *  ★重要: 直接の文字色は buildCleaningBoard を実行したときにだけ
 *    塗り直される。コードを新しくしただけでは古い赤は消えない。
 *
 *  シートには一切書き込まない。
 */
function explainRedKeys() {
  const C = CONFIG.COL_CLEAN;
  const A = CONFIG.CHECKIN_FORM_ALERT || {};
  const sh = ensureCleaningSheet();
  const last = sh.getLastRow();

  Logger.log('======== E列の赤字の出どころを調べる ========');
  Logger.log(`設定: ENABLED=${A.ENABLED} DAYS_AGO=${A.DAYS_AGO} ` +
             `COLOR=${A.COLOR} BOLD=${A.BOLD}`);

  const today = fmtDate(todayJst());
  const targets = [];
  for (let i = 1; i <= Math.max(1, Number(A.DAYS_AGO || 1)); i++) {
    targets.push(addDaysStr(today, -i));
  }
  Logger.log(`今日=${today} / いま赤字の対象になるチェックイン日: ${targets.join(', ')}`);

  if (last <= 1) { Logger.log('CleaningBoard が空です。'); return; }
  const n = last - 1;

  // ── (2) 条件付き書式に「文字色を変えるルール」が無いか ──────
  Logger.log('\n--- 条件付き書式のうち E列にかかるもの ---');
  let cfFont = 0;
  try {
    sh.getConditionalFormatRules().forEach((rule, i) => {
      const covers = rule.getRanges().some(r =>
        r.getColumn() <= C.KEY && (r.getColumn() + r.getNumColumns() - 1) >= C.KEY);
      if (!covers) return;
      const bc = rule.getBooleanCondition();
      const fontColor = bc ? bc.getFontColor() : null;
      const bg = bc ? bc.getBackground() : null;
      Logger.log(`  ルール${i + 1}: 文字色=${fontColor || '(変えない)'} 背景=${bg || '-'} ` +
                 `条件=${bc ? bc.getCriteriaType() : '?'} ` +
                 `${bc ? JSON.stringify(bc.getCriteriaValues()) : ''}`);
      if (fontColor) cfFont++;
    });
  } catch (e) {
    Logger.log(`  (条件付き書式を読めませんでした: ${e})`);
  }
  if (cfFont) {
    Logger.log(`  !! 文字色を変える条件付き書式が ${cfFont} 件あります。`);
    Logger.log('     このスクリプトが付けた赤字とは別物です。');
    Logger.log('     赤字が意図と違うなら、まずこのルールを疑ってください。');
  } else {
    Logger.log('  文字色を変える条件付き書式はありません。');
    Logger.log('  → 赤いセルは「直接付いた文字色」です。');
  }

  // ── (1)(3) 直接付いている文字色を全部見る ────────────────────
  const colors = sh.getRange(2, C.KEY, n, 1).getFontColors();
  const weights = sh.getRange(2, C.KEY, n, 1).getFontWeights();
  const keys  = sh.getRange(2, C.KEY,  n, 1).getValues();
  const dates = sh.getRange(2, C.DATE, n, 1).getValues();
  const rooms = sh.getRange(2, C.ROOM, n, 1).getValues();
  const states= sh.getRange(2, C.STATE,n, 1).getValues();
  const names = sh.getRange(2, C.GUEST_NAME, n, 1).getValues();

  const isBlack = c => {
    const s = String(c || '').toLowerCase();
    return !s || s === '#000000' || s === '#000' || s === 'black' || s === 'general';
  };

  const reds = [];
  for (let i = 0; i < n; i++) if (!isBlack(colors[i][0])) reds.push(i);

  Logger.log(`\n--- 直接の文字色が黒以外の E列セル: ${reds.length} 件 ---`);
  if (!reds.length) {
    Logger.log('  ありません。画面で赤く見えるなら条件付き書式か、表示上の別要因です。');
  }

  // Check-In Form と突合して、いま塗るべきかどうかを出す
  const map = loadCheckinFormEntries();
  if (map === null) {
    Logger.log('  !! Check-In Form を読めていません (dumpCheckinForm で確認)。');
  }

  //  ★日付列はシートに書くと Google 側で日付値に変換されるため、
  //    文字列として比較すると必ず外れる。必ず fmtDate() を通す。
  reds.slice(0, 60).forEach(i => {
    const d = fmtDate(dates[i][0]);
    const room = String(rooms[i][0] || '').trim();
    const submitted = (map && map[`${d}|${room}`]) ? map[`${d}|${room}`].name : null;
    const shouldBeRed = (A.ENABLED !== false) && map && targets.indexOf(d) >= 0 && !submitted;

    Logger.log(`  行${i + 2} ${keys[i][0]}  色=${colors[i][0]} ${weights[i][0]}` +
      `  状態=${states[i][0]} 氏名=${names[i][0] || '-'}`);
    Logger.log(`        Check-In Form: ${submitted ? '提出済み (' + submitted + ')' : (map ? '未提出' : '判定不能')}` +
      ` / 対象日か: ${targets.indexOf(d) >= 0 ? 'はい' : 'いいえ'}` +
      ` → いま塗るべき: ${shouldBeRed ? 'はい' : '★いいえ'}`);
    if (!shouldBeRed) {
      Logger.log('        ※ 古い赤が残っています。buildCleaningBoard を実行すれば消えます。');
    }
  });

  // ── いま塗るべき行 ────────────────────────────────────────
  Logger.log('\n--- いま塗るべき行 (最新ロジックでの判定) ---');
  if (map === null) {
    Logger.log('  Check-In Form を読めないため、赤字は付けません。');
  } else {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const d = fmtDate(dates[i][0]);
      const room = String(rooms[i][0] || '').trim();
      if (targets.indexOf(d) < 0) continue;
      if (!states[i][0] || String(states[i][0]).indexOf('IN') < 0) continue;
      if (map[`${d}|${room}`]) continue;
      Logger.log(`  行${i + 2} ${keys[i][0]} ${names[i][0] || '-'} → 未提出`);
      m++;
    }
    if (!m) Logger.log('  ありません (対象日のチェックインは全員提出済み)。');
  }

  Logger.log('\n======== 判定 ========');
  Logger.log('赤いのに「いま塗るべき: いいえ」が並ぶ場合、原因は次のどれかです:');
  Logger.log('  A. コードを更新しただけで buildCleaningBoard を実行していない');
  Logger.log('     → 文字色は実行時にしか塗り直されません。実行すれば消えます。');
  Logger.log('  B. DAYS_AGO を大きくしたまま実行した名残');
  Logger.log('  C. 旧版 (食事フォームを見ていた v2.10.2) が塗ったもの');
}

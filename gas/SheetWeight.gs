/**
 * ============================================================
 *  SheetWeight.gs — スプレッドシートが重い原因を測る / 減らす
 * ============================================================
 *  症状: スマホの Google スプレッドシートアプリでこのファイルを開くと
 *        読み込みが終わらない。アプリを入れ直すと一時的に直る。
 *
 *  アプリ側の不具合も絡むが、こちら側で減らせるものは3つある。
 *
 *   ① グリッドの大きさ (maxRows × maxColumns)
 *      使っていない空行・空列もアプリは読み込む。
 *      1000行のつもりでも裏が 5万行あると開けなくなる。
 *
 *   ② 条件付き書式の数式ルールが覆うセル数
 *      数式ルール (=$G2="OUT→IN" など) は1セルずつ評価される。
 *      範囲が 2000行 × 20列 なら 1ルールで4万セル。
 *      ルールが4つあれば16万セル。スマホで止まる定番の原因。
 *
 *   ③ セルに入っている文字の量
 *      原文JSON のような長い文字列は件数が増えると効いてくる。
 *
 *  diagnoseSheetWeight() は測るだけ。書き込みはしない。
 *  trimSheetGrids() は ①を実際に削る (確認してから実行すること)。
 * ============================================================
 */

/** 重さの測定。書き込みはしない。 */
function diagnoseSheetWeight() {
  const ss = SpreadsheetApp.getActive();
  const sheets = ss.getSheets();
  const L = [];

  L.push('════════════════════════════════════════════');
  L.push('  スプレッドシートの重さ診断  ※書き込みなし');
  L.push('════════════════════════════════════════════');
  L.push(`ファイル: ${ss.getName()}  / シート数: ${sheets.length}`);
  L.push('');

  let totalCells = 0, totalUsed = 0, totalCF = 0, totalChars = 0;
  const rows = [];

  sheets.forEach(sh => {
    const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
    const lastR = sh.getLastRow(), lastC = sh.getLastColumn();
    const grid = maxR * maxC;
    const used = Math.max(0, lastR) * Math.max(0, lastC);

    //  条件付き書式が覆うセル数
    let cfCells = 0, cfRules = 0;
    try {
      const rules = sh.getConditionalFormatRules();
      cfRules = rules.length;
      rules.forEach(rule => {
        rule.getRanges().forEach(rg => { cfCells += rg.getNumRows() * rg.getNumColumns(); });
      });
    } catch (e) { /* 取れないシートは0のまま */ }

    //  文字量 (使用範囲だけ、表示文字列で測る)
    let chars = 0;
    const heavy = [];
    if (lastR > 0 && lastC > 0 && used <= 400000) {
      try {
        const vals = sh.getRange(1, 1, lastR, lastC).getDisplayValues();
        const perCol = new Array(lastC).fill(0);
        vals.forEach(r => {
          for (let c = 0; c < lastC; c++) {
            const n = String(r[c] || '').length;
            chars += n; perCol[c] += n;
          }
        });
        perCol.map((n, i) => ({ col: i + 1, n: n }))
          .sort((a, b) => b.n - a.n).slice(0, 3)
          .filter(x => x.n > 0)
          .forEach(x => heavy.push(`${colLetter_(x.col)}列 ${Math.round(x.n / 1000)}k字`));
      } catch (e) { /* 大きすぎて読めない場合は飛ばす */ }
    }

    totalCells += grid; totalUsed += used; totalCF += cfCells; totalChars += chars;
    rows.push({ name: sh.getName(), maxR, maxC, lastR, lastC, grid, used, cfRules, cfCells, chars, heavy });
  });

  rows.sort((a, b) => (b.grid + b.cfCells) - (a.grid + a.cfCells));

  L.push('── シートごと (重い順) ─────────────────────');
  rows.forEach(r => {
    const wasteR = r.maxR - r.lastR, wasteC = r.maxC - r.lastC;
    L.push(`${r.name}`);
    L.push(`   グリッド ${r.maxR}行 × ${r.maxC}列 = ${fmtNum_(r.grid)}セル`
      + `   / 使用 ${r.lastR}行 × ${r.lastC}列 = ${fmtNum_(r.used)}セル`);
    if (wasteR > 100 || wasteC > 5) {
      L.push(`   ★未使用 ${wasteR}行 / ${wasteC}列 が余っている`
        + ` (${fmtNum_(r.grid - r.used)}セルぶん)`);
    }
    if (r.cfRules) {
      L.push(`   条件付き書式 ${r.cfRules}ルール → ${fmtNum_(r.cfCells)}セルを評価`
        + (r.cfCells > 50000 ? '   ★重い' : ''));
    }
    if (r.chars) {
      L.push(`   文字量 ${Math.round(r.chars / 1000)}k字`
        + (r.heavy.length ? `   (多い列: ${r.heavy.join(' / ')})` : ''));
    }
  });

  L.push('');
  L.push('── 合計 ───────────────────────────────────');
  L.push(`   グリッド     ${fmtNum_(totalCells)}セル  (うち使用 ${fmtNum_(totalUsed)})`);
  L.push(`   条件付き書式 ${fmtNum_(totalCF)}セルを評価`);
  L.push(`   文字量       ${Math.round(totalChars / 1000)}k字`);

  L.push('');
  L.push('── 判定 ───────────────────────────────────');
  const verdict = [];
  if (totalCells > 500000) {
    verdict.push(`グリッドが ${fmtNum_(totalCells)}セル。使っていない行・列が多い。`
      + ' trimSheetGrids() で削れる。');
  }
  if (totalCF > 150000) {
    verdict.push(`条件付き書式が ${fmtNum_(totalCF)}セルを評価している。`
      + ' 数式ルールはセルごとに計算されるのでスマホが止まる主因になりやすい。'
      + ' setupCleaningFormatting() を実行し直すと実データの行数に合わせて縮む。');
  }
  if (totalChars > 2000000) {
    verdict.push(`文字量が ${Math.round(totalChars / 1000)}k字。`
      + ' 原文JSON のような長い列が効いている可能性がある。');
  }
  if (!verdict.length) verdict.push('こちら側で減らせる明らかな原因は見当たらない。');
  verdict.forEach(v => L.push(`   ・${v}`));

  L.push('');
  L.push('── Sheets アプリ側でできること ────────────');
  L.push('   ・アプリではなく Chrome でスプレッドシートを開く');
  L.push('   ・アプリの設定 → ストレージ → キャッシュを削除');
  L.push('     (入れ直しと同じ効果で、ログインし直さずに済む)');

  Logger.log(L.join('\n'));
  return rows;
}

/**
 * 使っていない行・列を削ってグリッドを縮める。
 *  ★データは消さない。使用範囲より下 / 右の空白だけを削る。
 *  ★余白 (BUFFER) は残す。清掃ボードは毎日2行ずつ伸びるため。
 */
function trimSheetGrids() {
  const BUFFER_ROWS = 200;   // 清掃ボードが伸びる余地 (100日ぶん)
  const BUFFER_COLS = 2;
  const ss = SpreadsheetApp.getActive();
  const L = [];
  let saved = 0;

  ss.getSheets().forEach(sh => {
    const name = sh.getName();
    const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
    const lastR = Math.max(1, sh.getLastRow()), lastC = Math.max(1, sh.getLastColumn());

    const keepR = lastR + BUFFER_ROWS;
    const keepC = lastC + BUFFER_COLS;
    let dr = 0, dc = 0;

    if (maxR > keepR) {
      dr = maxR - keepR;
      sh.deleteRows(keepR + 1, dr);
    }
    if (maxC > keepC) {
      dc = maxC - keepC;
      sh.deleteColumns(keepC + 1, dc);
    }
    if (dr || dc) {
      const before = maxR * maxC;
      const after = (maxR - dr) * (maxC - dc);
      saved += (before - after);
      L.push(`${name}: ${dr}行 / ${dc}列 を削除`
        + `  ${fmtNum_(before)} → ${fmtNum_(after)}セル`);
    }
  });

  if (!L.length) L.push('削れる空行・空列はありませんでした。');
  else L.push(`合計 ${fmtNum_(saved)}セルぶん軽くなりました。`);
  L.push('');
  L.push('※データは消していません。使用範囲より下・右の空白だけを削りました。');
  L.push(`※清掃ボードが伸びる余地として ${BUFFER_ROWS}行 残してあります。`);

  Logger.log(L.join('\n'));
  return saved;
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

function fmtNum_(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

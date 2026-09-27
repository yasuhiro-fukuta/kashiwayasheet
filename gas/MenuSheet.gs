/**
 * ============================================================
 *  MenuSheet.gs - 食事料金表「メニュー」シート (v1)
 * ============================================================
 *  チャットボット (kashiwaya-lp) が食事の料金を答えるための
 *  唯一の正 (source of truth)。Googleフォームのスクレイピングを
 *  置き換えるもの。
 *
 *  ★価格は Lodgify アドオンと同じ「セット単位」(人数分込み)。
 *    1人あたりの単価ではない。
 *  ★このシートは人が手で編集する。バッチは一切書き込まない。
 *    読むのは WebApi.gs の doGet (?part=menu) だけ。
 *  ★商品名は Lodgify 管理画面のアドオン名と完全一致させておくと
 *    突合が楽 (将来 Config.gs の ADDON_UNITS の供給元にもできる)。
 *
 *  列: A 商品名 / B 区分(夕食・朝食) / C 人数 / D 価格(円) /
 *      E 有効(FALSEで非表示) / F 備考
 *
 *  ── セットアップ (1回だけ) ──────────────────────────────
 *  エディタでこのファイルを開き setupMenuSheet を実行すると、
 *  「メニュー」シートが無い場合に作成して現在の Lodgify アドオン
 *  価格を書き込む。★シートが既にある場合は何もしない
 *  (手動編集を上書きしないため)。
 * ============================================================
 */

function setupMenuSheet() {
  const ss = SpreadsheetApp.getActive();
  const name = CONFIG.SHEET.MENU;
  if (ss.getSheetByName(name)) {
    Logger.log('シート「' + name + '」は既にあります。何もしません。');
    return;
  }

  const sh = ss.insertSheet(name);
  const header = ['商品名', '区分', '人数', '価格(円)', '有効', '備考'];
  const rows = [
    ['Dinner - Chicken Hot Pot for 2',                             '夕食', 2,  6000, 'TRUE', ''],
    ['Dinner - Chicken Hot Pot for 3',                             '夕食', 3,  8000, 'TRUE', ''],
    ['Dinner - Pork Hot Pot (Shabu-shabu) for 2',                  '夕食', 2,  8000, 'TRUE', ''],
    ['Dinner - Pork Hot Pot (Shabu-shabu) for 3',                  '夕食', 3, 11000, 'TRUE', ''],
    ['Dinner - Pork Chilled Pot (Rei-shabu) for 2',                '夕食', 2,  8000, 'TRUE', ''],
    ['Dinner - Pork Chilled Pot (Rei-shabu) for 3',                '夕食', 3, 11000, 'TRUE', ''],
    ['Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 2',               '夕食', 2, 10000, 'TRUE', ''],
    ['Dinner - Wagyu Beef Hot Pot (Sukiyaki) for 3',               '夕食', 3, 14000, 'TRUE', ''],
    ['Dinner - Vegan Gluten-free Hot Pot for 2',                   '夕食', 2,  8000, 'TRUE', ''],
    ['Dinner - Vegan Gluten-free Hot Pot for 3',                   '夕食', 3, 11000, 'TRUE', ''],
    ['Dinner - Vegan Gluten-free Chilled Pot for 2',               '夕食', 2,  8000, 'TRUE', ''],
    ['Dinner - Vegan Gluten-free Chilled Pot for 3',               '夕食', 3, 11000, 'TRUE', ''],
    ['Breakfast - Ochazuke risotto and Miso soup with pickles for 1', '朝食', 1, 1500, 'TRUE', '1人前・個数分注文'],
  ];

  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 380);
  sh.setColumnWidth(6, 220);
  Logger.log('シート「' + name + '」を作成しました (' + rows.length + '品)。');
}

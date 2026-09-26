/**
 * ============================================================
 *  Kashiwaya Reservation Sync v2.10 - Config.gs
 * ============================================================
 *  LatestOptions 13列構造 (M列「曜日」は手動の WEEKDAY 数式のため
 *  スクリプトからは一切触らない):
 *  1:バッチ処理日時 2:論理削除フラグ 3:フォーム送信日時
 *  4:宿泊日 5:部屋 6:宿泊者名
 *  7:人数 8:食事サマリ 9:オプションサマリ 10:その他要望
 *  11:フォーム原文(JSON) 12:ほなみや転記済(手動) 13:曜日(手動数式)
 *
 *  ── v2.10: 報告された2件の不具合を修正 ──────────────────────
 *
 *  (1) Lodgify 直予約の情報が取れない
 *      原因: 清掃ボードの在室骨格を LatestReservations
 *            (= Booking.com / Airbnb の iCal) だけから作っていた。
 *            Lodgify の自社予約ページ・管理画面から入った直予約は
 *            どの OTA の iCal にも現れないため、実際には客がいる部屋が
 *            「空室」と表示されていた。
 *            ※ Lodgify API からの取得自体は成功していた。
 *              落ちていたのは取得後の突合の方。
 *      対策: CleaningBoard.gs の mergeLodgifyStays() で、
 *            iCal が押さえていない夜だけ Lodgify 予約を骨格に合流。
 *
 *  (2) 食事予約表の人数が取れないことがある
 *      原因: 現行の Google フォームに人数設問が無く、
 *            LatestOptions G列(人数) が空のまま溜まっていた。
 *            実データでは有効44行のうち23行が空欄。
 *      対策: GuestCount.gs の backfillOptionGuests() で
 *            Lodgify → 食事推定 の順に空欄だけを埋める。
 *            上記23行のうち21行が Lodgify から埋まることを確認済み
 *            (残り2行は宿泊済みで Lodgify の取得対象外になった過去分)。
 *
 *  あわせて修正した細かい不具合:
 *   ・LodgifyBookings の upsert キーに「解決後の部屋(1F/2F)」を
 *     使っていたため、ROOM_MAP を直すと同じ予約が別行として増え、
 *     古い行に「削除」が立っていた。キーを room_type_id ベースの
 *     安定値に変更。
 *   ・人数突合が Array.find() の先頭一致で、期間が重なる予約が
 *     複数あると行順まかせだった。→ findLodgifyBooking() に統一。
 *   ・全角数字 ("１人前") で食事からの人数推定が 0 になっていた。
 *   ・連泊の中日の日付でフォームが出されると食事が丸ごと落ちていた。
 *
 *  v2.9 まで: 清掃予定表の追加、Lodgify API 取得、泉屋送迎など。
 *  現行フォームの食事回答値は "3 person - ¥8,000" 形式。
 * ============================================================
 */

const CONFIG = {
  SHEET: {
    LATEST_RES:     'LatestReservations',
    PREV_RES:       'PrevReservations',
    DISAPPEARED:    'DisappearedRes',
    LATEST_OPT:     'LatestOptions',
    FORM_RAW:       'FormResponses',
    LODGIFY:        'LodgifyBookings',    // 蓄積・upsert
    CLEANING:       'CleaningBoard',      // 毎回再生成
    CLEAN_OVERRIDE: 'CleaningOverride',   // 手動入力・GASは読むだけ
    STAFF:          'Staff',              // 担当者一覧 (v2.11 追加・追記のみ)
    ISSUES:         '指摘事項',            // 手動入力の矛盾 (v2.13 追加・追記のみ)
  },

  // 指摘事項シートの列 (人が見て直す)
  //  論理削除が空の行 = いま検出されている指摘。
  //  解消すると GAS が「削除」を立てる。行は消さない。
  COL_ISSUE: {
    KEY:     1,   // プライマリキー = 元行のキー + '#' + ルールID
    DELETED: 2,   // 空欄 または 「削除」
    SHEET:   3,
    DATE:    4,
    ROOM:    5,
    ISSUE:   6,
  },

  // ── 手動入力の矛盾チェック (v2.13) ──────────────────────────
  //  全期間を見ると過去の済んだ話で埋まるため、対象日を絞る。
  //  DAYS_BACK  … 何日前まで遡って見るか (直したい直近の抜けを拾う)
  //  DAYS_AHEAD … 何日先まで見るか (先の予定の割り当て漏れを拾う)
  //
  //  RULES … 個々の検査の on/off。false にするとその指摘は出なくなる。
  //  運用に合わないルールが出てきたら、コードではなくここを切る。
  ISSUE_CHECK: {
    ENABLED:    true,
    DAYS_BACK:  3,
    DAYS_AHEAD: 60,
    RULES: {
      // 区間で見る (これが清掃の抜けを見る本命)
      cleanGap:       true,   // 前の退室から到着まで清掃が1日も無い

      // 1行で見る (入力そのものの食い違い)
      kindMissing:    true,   // 清掃担当がいるのに種類が空欄
      cleanerMissing: true,   // 種類があるのに清掃担当が空欄
      nightMissing:   true,   // 到着日なのに接客担当が空欄
      setsMismatch:   true,   // べ と 泊人 が不一致
      unknownStaff:   true,   // 担当者名が Staff シートに無い

      // LatestOptions
      orderedButGone: true,   // 予約が消えたのに ほなみや転記済=済
      mealNoStay:     true,   // 食事予約があるが在室が無い
      guestsMissing:  true,   // 人数が空欄
    },
  },

  // ── 担当者一覧 (AppSheet の「わたし」ドロップダウンの元) ────────
  //  CleaningBoard の A列/D列に実際に入っている名前を拾って溜める。
  //  IGNORE に入れた値は担当者として扱わない。
  STAFF: {
    IGNORE: ['-', 'ー', '―', 'none', 'なし'],
  },

  // Staff シートの列
  COL_STAFF: {
    NAME:       1,   // CleaningBoard と完全一致させる照合用の名前
    DISPLAY:    2,   // 人が読む名前 (手で編集してよい)
    ROLE:       3,   // 掃除 / 接客 / 掃除・接客
    FIRST_SEEN: 4,
    ACTIVE:     5,   // FALSE でドロップダウンから除外
  },

  COL_RES: {
    CHECKIN:        1,
    ROOM:           2,
    SOURCE:         3,
    RESERVATION_ID: 4,
    NIGHT_ID:       5,
    IDENTIFIER:     6,
    FETCHED_AT:     7,
    NOTE:           8,
  },

  COL_DIS: {
    CHECKIN:     1,
    ROOM:        2,
    DETECTED_AT: 3,
    SRC_RES_ID:  4,
    SRC_SOURCE:  5,
    SRC_IDENT:   6,
  },

  // LatestOptions の列
  COL_OPT: {
    BATCH_TS:       1,
    DELETED_FLAG:   2,
    FORM_TS:        3,
    CHECKIN:        4,
    ROOM:           5,
    GUEST_NAME:     6,
    GUESTS:         7,   // 現行フォームに設問なし → v2.10 でバッチが補完する
    MEAL_SUMMARY:   8,   // 食事サマリ (+ 食事備考があれば ⚠ 結合)
    OPT_SUMMARY:    9,   // オプションサマリ (泉屋送迎/荷物/タクシー/ガイド/Eバイク)
    OTHER_REQ:     10,   // 現行フォームに設問なし → 空欄
    FORM_JSON:     11,
    HONAMIYA_DONE: 12,
  },

  // ── LodgifyBookings の列 (19列) ─────────────────────────────
  //  予約ID + 部屋(生値) を一意キーとして upsert する蓄積シート。
  //  今回の取得結果に現れなかった行は論理削除フラグに「削除」を立てる
  //  だけで物理削除しない (DisappearedRes と同じ思想)。
  COL_LDG: {
    FETCHED_AT:    1,   // 最終取得日時
    FIRST_SEEN:    2,   // 初回取得日時
    DELETED_FLAG:  3,   // 今回取得に無ければ「削除」
    BOOKING_ID:    4,   // Lodgify booking id
    STATUS:        5,
    ROOM:          6,   // 1F / 2F に正規化したもの
    ROOM_RAW:      7,   // room_type_id または部屋名 (upsertキーの一部)
    GUEST_NAME:    8,
    GUESTS:        9,   // ★人数。これが取得の目的
    ADULTS:       10,
    CHILDREN:     11,
    CHECKIN:      12,
    CHECKOUT:     13,
    NIGHTS:       14,
    SOURCE:       15,   // Booking.com / Airbnb / 直予約ドメイン など
    AMOUNT:       16,
    CURRENCY:     17,
    RAW_JSON:     18,
    NOTE:         19,   // ★手書き。バッチで消さない
    ADDONS:       20,   // 予約時オプション(アドオン)の JSON。v2.14 で追加
  },

  // LodgifyBookings の列数。ensureLodgifySheet / upsert の書き込み幅。
  LDG_WIDTH: 20,

  // ── CleaningBoard の列 ────────────────────────────────────
  //  日付 × 部屋 で1行。
  //
  //  ★A〜D列は人が使う領域。GAS は読みも書きもしない。
  //    GAS の書き込みは E列 (キー) から始まる。
  //    = CONFIG.CLEANING.WRITE_START_COL
  //
  //  ★手動列を増やすときは必ず D列より左に足すこと。
  //    E列以降は連続した1ブロックとして毎回クリア＆書き込みするため、
  //    途中に手動列を挟むと毎バッチで消える。
  COL_CLEAN: {
    STAFF_DAY:    1,   // A 手動  GAS 非干渉
    CLEAN_MANUAL: 2,   // B 手動  GAS 非干渉
    SET_GUESTS:   3,   // C 手動  GAS 非干渉
    STAFF_NIGHT:  4,   // D 手動  GAS 非干渉

    KEY:          5,   // E ここから GAS が書く。yyyy-MM-dd_1F
    GUESTS:       6,   // F C/I人数 (その夜の在室人数)
    STATE:        7,   // G OUT→IN / OUT→空室 / 連泊 / IN / 空室
    DATE:         8,
    WEEKDAY:      9,
    ROOM:        10,
    GUESTS_SRC:  11,   // 手動 / Lodgify / フォーム / 食事推定 / 不明
    GUEST_NAME:  12,
    SOURCE:      13,
    CHECKIN_IN:  14,   // 本日チェックインする人
    CHECKOUT_OUT:15,   // 本日チェックアウトする人
    NEXT_IN:     16,   // 空室を挟む場合の次回チェックイン日
    NIGHTS:      17,
    MEAL:        18,
    NOTE:        19,
    UPDATED_AT:  20,   // T ここまで
  },

  // CleaningOverride の列 (5列) — 人が手で書くシート
  COL_OVR: {
    CHECKIN:    1,   // 宿泊日 (チェックイン日)
    ROOM:       2,
    GUESTS:     3,
    GUEST_NAME: 4,
    MEMO:       5,
  },

  ICAL_SOURCES: [
    {
      source: 'booking',
      room:   '1F',
      url:    'https://ical.booking.com/v1/export?t=eb02c0bf-34b8-46e3-878f-24930cd5d8b1',
    },
    {
      source: 'booking',
      room:   '2F',
      url:    'https://ical.booking.com/v1/export?t=f4118e63-1f17-4261-b60c-1071ad976dcd',
    },
    {
      source: 'airbnb',
      room:   '1F',
      url:    'https://www.airbnb.jp/calendar/ical/1469195071434996296.ics?t=737d726826224936817c38cbbba09add',
    },
    {
      source: 'airbnb',
      room:   '2F',
      url:    'https://www.airbnb.jp/calendar/ical/1474250382283766656.ics?t=8730276914cb4547a1d126aa03239aa3',
    },
  ],

  DAYS_THRESHOLD: 4,

  // ── Lodgify Public API 設定 ────────────────────────────────
  //  APIキーはここに書かない。Script Properties に保存する。
  //    エディタで setLodgifyApiKey('xxxxx') を1回実行する。
  LODGIFY: {
    ENABLED:      true,
    API_BASE:     'https://api.lodgify.com/v2/reservations/bookings',
    PROP_KEY:     'LODGIFY_API_KEY',
    PAGE_SIZE:    50,
    MAX_PAGES:    20,
    // 取り込む予約ステータス (小文字比較)
    VALID_STATUS: ['booked', 'open', 'confirmed'],

    //  実測で確定済み (2026-08 時点):
    //    793793 = Japanese-Style Room (1st floor)   → 1F
    //    793801 = Superior Family Room (2nd floor)  → 2F
    //    860944 / 860952 は上記レンタルに自動生成された room_type_id。
    //    API の rooms[].name は空で返るため、ID 引きが必須。
    ROOM_MAP: {
      '793793': '1F',
      '793801': '2F',
      '860944': '1F',
      '860952': '2F',
    },

    //  ★直予約の判定 (v2.10)
    //  Lodgify の source は OTA 経由だと "5326808288|6222108251" のような
    //  数字とパイプの組、直予約だと自社予約ページのドメインになる。
    //  ここに部分一致するものを直予約として扱い、清掃ボードの備考に
    //  「直予約」と出す。空文字 (管理画面での手入力) も直予約扱い。
    //  予約ページのドメインを変えたらここに足すこと。
    DIRECT_SOURCE_PATTERNS: [
      'lodgify.com',
      'direct',
      'website',
      'manual',
    ],

    // ── 予約時オプション (Lodgify Add-ons) ────────────────────
    //  Lodgify のチェックアウト画面で売っている追加商品。
    //  例) "Dinner - Chicken Hot Pot for 3" ¥8,000 x1
    //
    //  ★これを GoogleForm の食事オプションと同じ扱いにする。
    //    = LatestOptions (食事予約表) に行を作る。
    //      そこに乗れば CleaningBoard の食事列にも自動で出る。
    //
    //  ★フィールド名が確定できていない。
    //    Lodgify の API リファレンスは公開ドキュメントに
    //    アドオンの項目が載っておらず、実レスポンスで確かめる以外に
    //    確認手段が無い。そのため次の2段構えにしている:
    //
    //      1) KEYS に挙げた名前の配列があればそれを採用する (無条件)
    //      2) 無ければ JSON を再帰的に走査し、
    //         「名前らしき文字列 + 個数か金額」を持つ物を候補にする。
    //         ただし候補は CONFIG.MEALS か MEAL_HINTS に一致した物だけ
    //         採用する (誤検出を出さないため)。
    //
    //    実レスポンスを見たら KEYS の先頭に正しい名前を足すこと。
    //    確認は メニュー「🍱 Lodgify アドオン確認」(dumpLodgifyAddons)。
    ADDONS: {
      ENABLED: true,

      // 1) 無条件に採用するキー名 (アドオン専用の名前だけを並べる)
      KEYS: [
        'add_ons', 'addons', 'addOns',
        'booking_add_ons', 'bookingAddOns', 'add_on_items',
        'extras',
      ],

      // 2) 再帰走査を行うか
      SCAN_FALLBACK: true,
      // 再帰走査で降りない枝 (料率・税・入金などの明細)
      SCAN_SKIP_KEYS: [
        'rate_details', 'rates', 'taxes', 'fees', 'transactions',
        'payments', 'promotions', 'messages', 'guest_breakdown',
        'currency', 'guest', 'owner', 'policies',
      ],
      SCAN_MAX_DEPTH: 6,

      // アドオン1件から名前 / 個数 / 金額を読むときの候補キー
      NAME_KEYS:  ['name', 'title', 'add_on_name', 'product_name', 'label', 'description', 'text'],
      QTY_KEYS:   ['quantity', 'qty', 'units', 'count', 'number', 'amount_of_units'],
      PRICE_KEYS: ['total', 'total_amount', 'subtotal', 'price', 'amount'],

      //  "Dinner - Chicken Hot Pot for 3" の先頭の区分を落とす。
      //  これを落とさないと CONFIG.MEALS の ^ 始まりの正規表現に
      //  一致しない。
      STRIP_PREFIX: /^\s*(?:dinner|breakfast|lunch|brunch|supper|meal|food|option|add[-\s]?on|夕食|朝食|昼食|食事|オプション)\s*[-–—:：/|]+\s*/i,

      //  人前の読み取り。"for 3" / "3 persons" / "3人前" を拾う。
      //  parsePersonCount() が拾えない "for 3" 形式を先に見る。
      PORTION_PATTERNS: [
        /\bfor\s+(\d+)\b/i,
        /(\d+)\s*(?:persons?|people|pax|servings?)\b/i,
      ],

      //  再帰走査で拾った候補を「食事」と見なす追加ヒント。
      //  CONFIG.MEALS に無いが食事であるもの (新メニュー等) を
      //  取りこぼさないための保険。
      MEAL_HINTS: [
        /dinner/i, /breakfast/i, /hot\s*pot/i, /shabu/i, /sukiyaki/i,
        /chirashi/i, /ochazuke/i, /夕食/, /朝食/, /鍋/,
      ],

      //  食事以外のアドオン (レイトチェックアウト等) を
      //  オプションサマリ (I列) に出すか。
      NON_MEAL_TO_OPTION: true,

      //  LatestOptions の その他要望 (J列) に入れる出所タグ。
      //  女将が「フォームを探しても無い」で迷わないようにする。
      ORIGIN_TAG: 'Lodgify予約時オプション',
    },
  },

  // ── 清掃ボード生成設定 ─────────────────────────────────────
  CLEANING: {
    ROOMS: ['1F', '2F'],

    // ★開始日を固定する。
    //   固定日を起点にすれば行は下に伸びるだけになり、
    //   既存行の位置は永久に動かない (A〜D列の手動入力が守られる)。
    //   一度決めたら変えないこと。
    START_DATE: '2026-08-01',

    // 今日から何日先まで生成するか。
    //
    //  ★120日だと直予約の取りこぼしが起きる (v2.10.1 で 400 に変更)。
    //    Lodgify の直予約は半年〜1年先で入ることがあり、120日では
    //    ボードに行が生成されず「取得できているのに見えない」状態に
    //    なっていた。実際に Amanda McLaughlin (2027-03-31) と
    //    Dragan Sekulic (2027-03-29〜30 / 04-01) の4泊が範囲外だった。
    //
    //    START_DATE は固定なので、ここを増やしても行は下に伸びるだけ。
    //    既存行の位置は動かず、A〜D列の手動入力はずれない。
    //    400日で 2026-08-01 起点の約870行になる。
    DAYS_AHEAD: 400,

    // GAS が書き込みを開始する列 (E=5)。
    // A〜D列は手動入力用。
    WRITE_START_COL: 5,
  },

  // ── Check-In Form (宿泊者名簿) の場所 (v2.10.3) ────────────────
  //  ★食事・オプションの注文フォーム (FormResponses) とは別物。
  //    回答は別スプレッドシートに溜まる。
  //      FormResponses … 食事の注文、泉屋送迎・荷物・タクシー等
  //      Check-In Form … 代表者氏名 / 住所 / 職業 / 電話番号
  //
  //  SPREADSHEET_ID は回答スプレッドシートのURLの
  //    docs.google.com/spreadsheets/d/【ここ】/edit
  //  の部分。
  //
  //  列は見出し名で探すので、フォームに設問を足して列がずれても壊れない。
  //  見出しを変えたときだけ、下の候補に追記すること。
  CHECKIN_FORM: {
    SPREADSHEET_ID: '1IXVZLzJwJeaBG9Zi8xA6P32zK9L5E9h5DVC3ag3qsco',
    SHEET_NAME:     'Form_Responses',
    HEADER_CHECKIN: ['Check-in Date', 'Check-in date', 'チェックイン日'],
    HEADER_ROOM:    ['Room Name', 'Room', '部屋'],
    HEADER_NAME:    ['Full Name of representative', 'Name', '代表者', '氏名'],
  },

  // ── Check-In Form 未提出の警告 (v2.10.2) ──────────────────────
  //  チェックイン日が「今日 - DAYS_AGO」なのに Check-In Form
  //  (= 上の CHECKIN_FORM で指定した宿泊者名簿のフォーム) の記入が
  //  無い滞在について、清掃ボードの E列(キー) を赤字にして目立たせる。
  //
  //  ・判定は CHECKIN_FORM の回答に (宿泊日, 部屋) で突合できるか。
  //    フォームを読めない場合 (ID誤り・権限なし) は判定不能として
  //    赤字を一切付けない。誤検知で催促するより安全側に倒す。
  //  ・DAYS_AGO: 1 なら「昨日チェックインした人」だけが対象。
  //    数日さかのぼって追いかけたい場合は 2, 3 と増やす
  //    (その日数分「前の日」まで対象が広がる)。
  //  ・書式はバッチのたびに E列全体をいったん既定色へ戻してから
  //    付け直す。戻さないと一度赤くなったセルが永久に赤いままになる。
  //  ・状態が「OUT→IN」の行は条件付き書式で背景が赤系(#FF7C80)になる。
  //    その上でも読めるよう、既定色は濃い赤 + 太字にしてある。
  CHECKIN_FORM_ALERT: {
    ENABLED:  true,
    DAYS_AGO: 1,          // 1 = 昨日チェックインした人
    COLOR:    '#A50E0E',  // 濃い赤 (赤背景の上でも読める)
    BOLD:     true,
  },

  // ── 食事設問 → サマリ表示の対応表 ────────────────────────────
  // ・test: FormResponses のヘッダーを「先頭一致(^)」で判定する。
  //   現行フォームの食事列はメニュー名で始まる素のヘッダー
  //   ("Chicken Hot Pot Set – ...")。一方、旧フォームの遺物列は
  //   "Dinner Sets (...)" や "Breakfast: [...]" で始まるため、^ 指定だけで
  //   自動的に除外され、誤マッチしない。
  // ・findIndex は配列の上から最初にマッチした1件を採用 (限定的なものを上に)。
  // ・order: サマリ内での表示順 (マッチ優先度=配列順 とは独立)。
  // ・label: サマリ表示名。
  MEALS: [
    { test: /^\s*Vegan\s+Cold\s+Shabu/i,                 label: 'Vegan Cold Shabu-Shabu',  kind: 'dinner',    order: 4 },
    { test: /^\s*Cold\s+Shabu/i,                         label: 'Cold Shabu-Shabu',        kind: 'dinner',    order: 3 },
    { test: /^\s*Chicken\s+Hot\s+Pot/i,                  label: 'Chicken Hot Pot',         kind: 'dinner',    order: 1 },
    { test: /^\s*Vegan\s+Hot\s+Pot|^\s*Chirashi/i,       label: 'Vegan Hot Pot & Chirashi',kind: 'dinner',    order: 5 },
    { test: /^\s*(?:Japanese\s+)?(?:Wagyu\s+)?Sukiyaki/i,label: 'Wagyu Sukiyaki',          kind: 'dinner',    order: 6 },
    { test: /^\s*Shabu[-\s]?Shabu/i,                     label: 'Shabu-Shabu',             kind: 'dinner',    order: 2 },
    { test: /^\s*Ochazuke/i,                             label: 'Ochazuke Breakfast',      kind: 'breakfast', order: 9 },
  ],

  // 食事サマリに価格(¥6,000等)も併記するか
  MEAL_SHOW_PRICE: false,

  // ── オプション設問 (Yes/No 系) → サマリ表示の対応表 ──────────
  //   id            … ログ用の識別子 (シートには出ない)
  //   label         … オプションサマリに出す表示名
  //   order         … サマリ内での表示順 (小さいほど左)
  //   ask           … Yes/No 設問のヘッダー候補
  //   count         … 個数設問のヘッダー候補。あれば " x2" のように付く
  //   detail        … 補足テキスト設問のヘッダー候補。あれば "(→...)" で付く
  //   validWeekdays … 提供曜日の制限 (ISO曜日 1=月 … 7=日)
  //   warnLabel     … 曜日ミスマッチ時の注意書き
  OPTIONS: [
    {
      id:    'izumiya_shuttle',
      label: '泉屋送迎',
      order: 1,
      ask: [
        'If it is WEDNESDAY & THURSDAY, would you like shuttle service to Izumiya dinner?',
        'shuttle service to Izumiya',
        'Izumiya dinner',
        '泉屋',
      ],
      validWeekdays: [3, 4],          // 水・木のみ
      warnLabel:     '曜日要確認',
    },
    {
      id:    'luggage',
      label: '荷物預け',
      order: 2,
      ask:   ['Would you like luggage storage?'],
      count: ['Number of luggage'],
    },
    {
      id:           'taxi',
      label:        'タクシー',
      order:        3,
      ask:          ['Would you like us to contact a taxi company for you?'],
      detail:       ['Full Destination Address'],
      detailPrefix: '→',
      detailMax:    20,
    },
    {
      id:    'activity',
      label: 'アクティビティ',
      order: 4,
      ask:   ['Would you like to reserve an activity guide?'],
    },
    {
      id:    'ebike',
      label: 'Eバイク',
      order: 5,
      ask:   ['would you like to reserve the bike?'],
      count: ['How many bikes would you like to reserve the bike?'],
    },
  ],

  PROP: {
    LAST_PROCESSED: 'LAST_PROCESSED_AT',
    LAST_OPEN_RUN:  'LAST_OPEN_RUN_AT',
  },

  DEBUG: true,
  TZ: 'Asia/Tokyo',
};

function setupScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  CONFIG.ICAL_SOURCES.forEach((s, i) => {
    props.setProperty(`ICAL_URL_${i}`, s.url);
  });
  Logger.log('Script Properties saved.');
}

/**
 * Lodgify APIキーを Script Properties に保存する。
 * エディタから setLodgifyApiKey('実際のキー') を1回だけ実行し、
 * 実行後はこの呼び出しを消すこと (履歴にキーを残さないため)。
 */
function setLodgifyApiKey(key) {
  if (!key) throw new Error('キーが空です');
  PropertiesService.getScriptProperties().setProperty(CONFIG.LODGIFY.PROP_KEY, String(key).trim());
  Logger.log('Lodgify API key saved.');
}

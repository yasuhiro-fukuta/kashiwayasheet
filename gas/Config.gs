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
    MENU:           'メニュー',            // 食事料金表。手動管理・チャットボットの料金の正 (MenuSheet.gs)
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

    //  ★U列以降も人の領域。GAS は読むだけで絶対に書かない。
    //    (E〜T と違い連続ブロックの外なので毎バッチのクリア対象外)
    CLEAN_RATE:   21,  // U 手動  清掃達成率   GAS 読み取り専用
    CLEAN_REDO:   22,  // V 手動  清掃やり直した箇所 GAS 読み取り専用
    NIGHT_HALF:   23,  // W 手動  接客半日？   GAS 読み取り専用
    SPECIAL_SPOT: 24,  // X 手動  特別清掃箇所 GAS 読み取り専用。
                       //   特別清掃の予定・実績はここで管理する
                       //   (特シートに代わる置き場・2026-10-04)。
                       //   チャットボット (WebApi) が読む。
                       //   ★給料計算では金額に効かせない。
                       //     「やった内容」のメモとしてログに出すだけ。
  },

  // CleaningOverride の列 (6列) — 人が手で書くシート
  COL_OVR: {
    CHECKIN:    1,   // 宿泊日 (チェックイン日)
    ROOM:       2,
    GUESTS:     3,
    GUEST_NAME: 4,
    MEMO:       5,
    MEAL:       6,   // 食事の手動追記 (WhatsApp等で受けた1人前注文など)。
                     // CleaningBoard の食事列(R)に「 / 」区切りで合算される。
                     // ★R列への直書きは毎時バッチで消えるのでこちらに書く。
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
    //
    //  ★一棟貸し (Vacation-House-Rental) を足すときもここに書く。
    //    値は CONFIG.HOUSE.ROOM_KEY ('一棟')。
    //    ID が分からないときは メニュー「🔍 Lodgify レスポンス確認」
    //    (dumpLodgifyBookings) を実行すると、解決できなかった生値が
    //    「!! 部屋を解決できなかった生値」としてログに出る。
    ROOM_MAP: {
      '793793': '1F',
      '793801': '2F',
      '860944': '1F',
      '860952': '2F',
      //  Vacation-House-Rental (一棟貸し)。
      //    850548 = レンタルID (property_id) … 管理画面の Rentals に出る値
      //    917713 = room_type_id            … API が rooms[] で返す値
      //    2026-09-27 に実レスポンスと管理画面の両方で確定。
      //
      //    ★両方入れる理由: rooms[] が空で返ってきた予約は
      //      room_type_id の代わりに property_id が使われる
      //      (normalizeLodgifyBooking のフォールバック)。
      //      片方しか入れていないと、その予約だけ部屋未解決で落ちる。
      //      1F / 2F も同じ理由で2つずつ登録してある。
      //
      //    この予約は CleaningBoard の行にはならず、
      //    expandHouseStays() が 1F / 2F の2行に展開する。
      '850548': '一棟',
      '917713': '一棟',
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

      // ── 個別取得 (v2.16) ──────────────────────────────────
      //  ★一覧取得 GET /bookings のレスポンスでは
      //    quote.addon_items が null で返る。アドオンは
      //    個別取得 GET /bookings/{id} でしか取れない。
      //    (2026-09-27 に実レスポンスで確認。id=23393708)
      //
      //    全件に個別取得をかけると 180回以上叩くことになるので、
      //    一覧側の subtotals.addons > 0 の予約だけを対象にする。
      //    さらに、前回保存したアドオンの合計金額が
      //    subtotals.addons と一致していれば取得を省く。
      //    → 定常状態では追加の API 呼び出しはほぼ0になる。
      //  原文JSON (LodgifyBookings R列) に残す最大文字数。
      //  ★この列はどのコードも読んでいない (書き込むだけの調査用)。
      //    予約が増えるほど文字量が積み上がり、スマホのアプリで
      //    ファイルが開けなくなる原因になる。先頭だけ残す。
      //    0 = 全文を残す / -1 = 書かない
      RAW_JSON_MAX_CHARS: 400,

      DETAIL_FETCH:     true,
      DETAIL_MAX_FETCH: 30,     // 1バッチあたりの個別取得の上限 (暴走よけ)

      // ── 個数の逆算 (v2.16) ────────────────────────────────
      //  ★addon_items は個数を返さない。金額に畳み込まれている。
      //      実例: "Breakfast — Ochazuke ... for 1"  amount 4500
      //            → 画面上は ¥1,500 × 3。API からは 3 が読めない。
      //    "for N" だけ読むと 1人前になり、朝食を3人分ではなく
      //    1人分しか発注しないことになる。
      //
      //    そこで 個数 = 金額 ÷ 単価 で逆算する。
      //    単価はここに書く。test は「アドオンの description」に当てる。
      //    ★上から順に見て最初に当たったものを使うので、
      //      細かいもの (for 3 など) を先に書くこと。
      //
      //    単価が未設定のアドオンは個数1として扱い、
      //    食事サマリに「⚠個数未確認(¥金額)」を付けて人に知らせる。
      //    黙って1人前にすると発注漏れに直結するため。
      //    ★2026-09-27 に Lodgify 管理画面のアドオン一覧から転記。
      //      夕食はすべて「Single charge / Per stay」(基本は個数1)、
      //      朝食だけ「Per quantity / Per stay」(個数が動く)。
      //      個数が2以上でも 金額÷単価 で正しく割り出せる。
      ADDON_UNITS: [
        { test: /Chicken\s*Hot\s*Pot.*\bfor\s*3\b/i,                      unit:  8000 },
        { test: /Chicken\s*Hot\s*Pot.*\bfor\s*2\b/i,                      unit:  6000 },
        { test: /Pork\s*Hot\s*Pot.*\bfor\s*3\b/i,                         unit: 11000 },
        { test: /Pork\s*Hot\s*Pot.*\bfor\s*2\b/i,                         unit:  8000 },
        { test: /Pork\s*Chilled\s*Pot.*\bfor\s*3\b/i,                     unit: 11000 },
        { test: /Pork\s*Chilled\s*Pot.*\bfor\s*2\b/i,                     unit:  8000 },
        { test: /Wagyu\s*Beef\s*Hot\s*Pot.*\bfor\s*3\b/i,                unit: 14000 },
        { test: /Wagyu\s*Beef\s*Hot\s*Pot.*\bfor\s*2\b/i,                unit: 10000 },
        { test: /Vegan\s*Gluten[-\s]?free\s*Hot\s*Pot.*\bfor\s*3\b/i,    unit: 11000 },
        { test: /Vegan\s*Gluten[-\s]?free\s*Hot\s*Pot.*\bfor\s*2\b/i,    unit:  8000 },
        { test: /Vegan\s*Gluten[-\s]?free\s*Chilled\s*Pot.*\bfor\s*3\b/i,unit: 11000 },
        { test: /Vegan\s*Gluten[-\s]?free\s*Chilled\s*Pot.*\bfor\s*2\b/i,unit:  8000 },
        { test: /Ochazuke/i,                                                 unit:  1500 },
      ],
      //  逆算した個数が整数にならないときの許容幅 (端数・値引き対策)
      UNIT_TOLERANCE: 0.02,

      //  食事以外のアドオン (レイトチェックアウト等) を
      //  オプションサマリ (I列) に出すか。
      NON_MEAL_TO_OPTION: true,

      //  LatestOptions の その他要望 (J列) に入れる出所タグ。
      //  女将が「フォームを探しても無い」で迷わないようにする。
      ORIGIN_TAG: 'Lodgify予約時オプション',

      //  ★食事名の前に付ける「支払い済み」の印 (v2.20)。
      //    Lodgify のアドオンは宿泊予約と同時に決済されている。
      //    一方フォーム経由の食事は宿舎で支払う (未収)。
      //    同じ食事列に両方が並ぶので、印が無いと現地で
      //    二重請求・請求漏れが起きる。
      //    例) "(paid) Chicken Hot Pot(3人前), Ochazuke Breakfast(2人前)"
      //        → 前者は決済済み、後者はフォーム経由で当日精算
      //    空文字にすれば印を消せる。
      PAID_PREFIX: '(paid) ',
    },
  },

  // ── 一棟貸し (Vacation-House-Rental) ───────────────────────
  //  2026-09 から3部屋目として運用開始。
  //  実体は「1F と 2F を売止にして、無人の一棟貸しとして売る」もの。
  //  部屋貸しと一棟貸しは Lodgify 側で相互に売止になる (同時には売れない)。
  //
  //  ★CleaningBoard に3行目は作らない。
  //    CONFIG.CLEANING.ROOMS は ['1F','2F'] のまま動かさない。
  //    行数が変わると A〜D列の手動入力が全部ずれる (START_DATE と同じ理由)。
  //    代わりに expandHouseStays() が、一棟貸し1件を
  //    「同じ人が 1F と 2F を取った」形の2件に展開する。
  //
  //  ★布団の数 = その階で寝る人数。
  //    2人ずつ 1F → 2F → 1F → 2F の順に埋める。各階の上限は4。
  //      X  1F 2F        X  1F 2F
  //      1   1  0        5   3  2
  //      2   2  0        6   4  2
  //      3   2  1        7   4  3
  //      4   2  2        8   4  4
  //    (運用で決めた表。splitHouseGuests() がこの表を再現する)
  HOUSE: {
    ENABLED: true,

    //  内部キー。LodgifyBookings の「部屋」列にはこの値が入る。
    //  CleaningBoard の行にはならない (展開されて消える)。
    ROOM_KEY: '一棟',

    //  展開先。CONFIG.CLEANING.ROOMS と同じ並びにすること。
    FLOORS: ['1F', '2F'],

    //  各階の布団の上限と、1回に割り当てる人数
    CAP_PER_FLOOR: 4,
    FILL_BLOCK:    2,

    //  rooms[].name / property_name が返ってきた場合の保険。
    //  ★実測では Lodgify の rooms[].name は空で返るため、
    //    ROOM_MAP への ID 追記が本筋。こちらは当てにしない。
    NAME_PATTERNS: [
      /vacation[-\s_]*house/i,
      /whole[-\s_]*house/i,
      /entire[-\s_]*(house|home|place)/i,
      /一棟/,
    ],

    //  食事オプションをどの階の行に出すか。
    //  一棟貸しは1組の客なので、発注は1行にまとめる。
    //  1F は X>=1 なら必ず1名以上いるので 1F にする。
    MEAL_FLOOR: '1F',

    //  清掃ボードの備考に出す文言
    NOTE:        '一棟貸し',
    NOTE_NO_BED: '就寝なし',
    NOTE_OVER:   '⚠定員超過',
    NOTE_CLASH:  '⚠一棟貸しと部屋貸しが重複',
  },

  // ── 清掃ボード生成設定 ─────────────────────────────────────
  CLEANING: {
    //  ★一棟貸しを足しても、ここは ['1F','2F'] のまま。
    //    CONFIG.HOUSE のコメントを読むこと。
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
    //  ── Lodgify 予約時オプション(アドオン)の表記 ──────────────
    //   アドオンはフォームと**別の名前**が付いている。同じ料理は
    //   同じラベルに寄せないと、食事サマリでフォーム由来の行と
    //   表記が揃わず、ほなみやへの発注も読みにくくなる。
    //
    //     Lodgify のアドオン名                     → ラベル
    //     Pork Hot Pot (Shabu-shabu)              → Shabu-Shabu
    //     Pork Chilled Pot (Rei-shabu)            → Cold Shabu-Shabu
    //     Wagyu Beef Hot Pot (Sukiyaki)           → Wagyu Sukiyaki
    //     Vegan Gluten-free Hot Pot               → Vegan Hot Pot & Chirashi
    //     Vegan Gluten-free Chilled Pot           → Vegan Cold Shabu-Shabu
    //     Chicken Hot Pot / Ochazuke              → 既存の行で一致する
    //
    //   ★先頭に置いて先に判定させる。フォームの見出しは
    //     Pork / Wagyu Beef / Vegan Gluten-free で始まらないので
    //     既存の判定には影響しない。
    //   ★判定は「Dinner — 」を落とした後の文字列に当たる
    //     (stripLodgifyAddonPrefix)。
    { test: /^\s*Vegan\s+Gluten[-\s]?free\s+Chilled/i,   label: 'Vegan Cold Shabu-Shabu',  kind: 'dinner',    order: 4 },
    { test: /^\s*Vegan\s+Gluten[-\s]?free\s+Hot/i,       label: 'Vegan Hot Pot & Chirashi',kind: 'dinner',    order: 5 },
    { test: /^\s*Pork\s+Chilled\s+Pot/i,                 label: 'Cold Shabu-Shabu',        kind: 'dinner',    order: 3 },
    { test: /^\s*Pork\s+Hot\s+Pot/i,                     label: 'Shabu-Shabu',             kind: 'dinner',    order: 2 },
    { test: /^\s*Wagyu\s+Beef\s+Hot\s+Pot/i,            label: 'Wagyu Sukiyaki',          kind: 'dinner',    order: 6 },

    //  ── GoogleForm の見出し ─────────────────────────────────
    { test: /^\s*Vegan\s+Cold\s+Shabu/i,                 label: 'Vegan Cold Shabu-Shabu',  kind: 'dinner',    order: 4 },
    { test: /^\s*Cold\s+Shabu/i,                         label: 'Cold Shabu-Shabu',        kind: 'dinner',    order: 3 },
    { test: /^\s*Chicken\s+Hot\s+Pot/i,                  label: 'Chicken Hot Pot',         kind: 'dinner',    order: 1 },
    { test: /^\s*Vegan\s+Hot\s+Pot|^\s*Chirashi/i,       label: 'Vegan Hot Pot & Chirashi',kind: 'dinner',    order: 5 },
    { test: /^\s*(?:Japanese\s+)?Wagyu\s+(?:Beef\s+)?BBQ/i, label: 'Wagyu BBQ',             kind: 'dinner',    order: 7 },
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

  // ── 業務委託料(給料)の計算 v2.21 ───────────────────────────
  //  ★ここは「契約書の数字」をそのまま置く場所。
  //    契約を更新したらコードではなくここだけ直すこと。
  //
  //  根拠にしている契約は2本ある。別人・別契約なので混ぜないこと。
  //
  //   (1) 柏屋 業務委託契約書(2026) ver3.0  [2026/04〜2026/12]
  //       ・客室セットアップ業務   6,500円/件
  //         「1件」= その日宿泊しているすべての客室(宿泊組)に対して
  //                  業務を完了した場合
  //         特別報酬: 次回宿泊者が4人超 → その値×200円
  //                   直前宿泊者が4人超 → その値×300円
  //       ・客室徹底清掃業務       同日内15pt完了で 6,000円
  //                                15pt超は最大20ptまで割合で増額
  //       ・月末締め / 翌月末払い
  //       ・未完了は 進捗度合い×70% で協議
  //
  //   (2) 丸山理恵 業務委託契約 別紙1  [2026/09/01〜2026/11/30]
  //       ・A チェックイン対応のみ        2,400円/件 (税抜)
  //       ・B チェックイン対応+仕出し対応  4,800円/件 (税抜)
  //         「1件」= 1日あたり当該業務の遂行1回。
  //                  同日に複数組の到着があっても その日1件。
  //       ・客室清掃・リネン交換は業務範囲に含まない
  //       ・消費税は委託料に含まない。登録番号「なし」のため取扱いは協議
  //       ・末日締め / 翌月5日までに請求書 / 翌月末日までに振込
  PAYROLL: {
    // 客室セットアップ業務 (清掃担当 = CleaningBoard A列)
    SETUP: {
      UNIT_PRICE: 6500,

      //  1件の数え方。
      //   'day'  … (担当者, 日) で1件  ← 契約書の「その日の全客室」に忠実
      //   'room' … (担当者, 日, 部屋) で1件
      //  ★1Fと2Fを別の人が分担した日は 'day' だと両者に1件ずつ付く。
      //    契約書の「すべての客室に対して完了した場合」を厳格に読むと
      //    どちらも1件に満たないが、無給にするのは実務的でないため
      //    各自1件として扱う (= 分担した日は合計2件になる)。
      COUNT_UNIT: 'day',

      // B列(種類)が空の行は「清掃の予定が立っていない」とみなして数えない。
      REQUIRE_KIND: true,

      // B列(種類) のうち「特別(徹底清掃)」と判定する表記
      SPECIAL_KIND_PATTERNS: [/特別/, /徹底/, /特清/],
    },

    //  B列(種類)が「特別」の日の扱い (2026-10 発注者指示)。
    //
    //   ・1階も2階も特別 … その日まるごと徹底清掃1件として
    //                       15pt = 6,000円 で計算する。
    //                       セットアップ(6,500円)は付けない。
    //   ・片方の階だけ特別 … 布団2個の入替清掃であるかのように計算する。
    //                       = 通常のセットアップ1件(6,500円)として扱い、
    //                         特別報酬(4人超の加算)は付けない。
    SPECIAL_DAY: {
      //  両階が特別の日に充てる pt。DEEP.BASE_PT と同じにしておけば満額。
      BOTH_FLOORS_PT: 15,

      //  片階だけ特別のときに「布団いくつ分として扱うか」。
      //  BONUS.THRESHOLD(4) 以下なら特別報酬は自動的に0になる。
      ONE_FLOOR_FUTONS: 2,

      //  特シートに同じ (対応者, 日) の pt 行があるときは
      //  特シート側を正として、こちらの 6,000円 は付けない。
      //  (同じ作業を2回払わないため)
      //  ★DEEP.USE_SHEET が false の間は特シートを読まないので効かない。
      PREFER_DEEP_SHEET: true,
    },

    //  清掃の出来に応じた減額 (CleaningBoard U列・V列)
    //   U 清掃達成率        … '90%' / '0.9' / '90' のどれでも読む。空欄=100%
    //   V 清掃やり直した箇所 … 自由記述。「、」「/」「・」改行 で区切って数える
    //  ★どちらも人が手で書く列。GAS は読むだけ。
    SHORTFALL: {
      //  達成率の効かせ方。
      //   'pro_rata' … 6,500円 × 達成率        (90% → 5,850円)
      //   'contract' … 6,500円 × 達成率 × 0.70 (契約書の未完了条項に忠実)
      //   'none'     … 金額には効かせず内訳に出すだけ
      //  ★既定は 'pro_rata'。契約書の70%条項は「成果物が未完了のとき」の
      //    協議条項なので、一部やり直しに当てるのは重すぎると判断した。
      //    厳格に当てたい場合は 'contract' にする。
      RATE_MODE: 'pro_rata',
      CONTRACT_RATIO: 0.70,

      //  1件に複数行(1F/2F)がぶら下がるときの達成率のまとめ方。
      //   'avg' … 値が入っている行の平均  'min' … いちばん低い行に合わせる
      //  ★2026-10 発注者指示: 1階と2階でパーセントが違う日は
      //    足して2で割る → 'avg' で確定。
      //    片方が未記入の日は、記入のある方をそのまま使う
      //    (未記入を0%とみなして半分にしない)。
      AGGREGATE: 'avg',

      //  やり直した箇所 1箇所あたりの減額。
      //  ★既定 0。勝手に金額を引かないため。
      //    1箇所いくら引くか決まったらここに入れる。
      //    0 のままでも、やり直した箇所はログの内訳に必ず出る。
      REDO_DEDUCTION: 0,

      //  達成率が空欄で「やり直した箇所」だけ埋まっている行に出す注意書き
      REDO_ONLY_NOTE: '⚠やり直しあり・達成率未入力 (減額なしで計算)',
    },

    //  作業メモ (清掃ボード V列・X列)。
    //  ★金額には一切効かせない。請求のときに「何をやったか」が
    //    わかるよう、ログに内訳として出すだけ。
    //    V 清掃やり直した箇所 … 減額の根拠にもなる (SHORTFALL 参照)
    //    X 特別清掃箇所       … やった内容のメモ。金額には無関係
    MEMO: {
      ENABLED: true,
    },

    // 特別報酬 (人数が多い日の加算)
    BONUS: {
      THRESHOLD: 4,       // 「4人を超えた場合」
      NEXT_RATE: 200,     // 次回宿泊者
      PREV_RATE: 300,     // 直前宿泊者

      //  「その値×200円」の「その値」の読み。
      //   'headcount' … 人数そのもの   (5名 → 5×200 = 1,000円)
      //   'excess'    … 4人を超えた分 (5名 → 1×200 =   200円)
      //  ★2026-10 に発注者より 'excess' (4人を超えた分) で確定。
      //    ログには引き続き両方の金額を併記する (検算用)。
      BASE: 'excess',

      //  1日に複数の部屋を掃除したときの人数の数え方。
      //   true  … その日の全部屋を合計してから「4人超」を判定する
      //           (1F 4名 + 2F 2名 = 6名 → (6-4)×200 = 400円)
      //   false … 部屋ごとに判定する
      //           (1F 4名 → 0円、2F 2名 → 0円 で合計0円)
      //
      //  ★2026-10 発注者指示により true。
      //    セットアップの「1件」が日単位 (その日の全客室) である以上、
      //    人数もその日の全客室の合計で見るのが筋。
      //    部屋ごとに判定すると 4名+2名 の日が丸ごと対象外になる。
      SUM_ROOMS: true,

      //  人数をどの列から採るか。
      //   'guests' … F列 泊人   (その夜の宿泊人数。Lodgify等から自動)
      //   'sets'   … C列 べ     (セット人数 = 敷いた布団の数。手入力)
      //  ★契約書の文言は「宿泊者の人数」なので既定は 'guests'。
      //    ただし実務上は「敷いた布団の数」で見たい場合がある。
      //    2つは食い違うことがある (矛盾チェックの setsMismatch 参照)。
      //    diagnoseSetupBonus() で両方の読みの金額を並べて確認できる。
      SOURCE: 'guests',
    },

    // 客室徹底清掃業務
    DEEP: {
      //  ★2026-10 発注者指示により「特」シートは給料計算では無視する。
      //    徹底清掃の報酬は、清掃ボードで両階とも「特別」になっている日
      //    (= SPECIAL_DAY) からだけ出す。
      //    特シートを使う運用に戻すときは true にする。
      USE_SHEET:  false,

      SHEET:      '特',
      BASE_PT:    15,     // この pt で満額
      MAX_PT:     20,     // ここまでは比例で増額
      BASE_PRICE: 6000,   // BASE_PT 分の報酬

      // BASE_PT に届かない日の扱い。契約書 = 進捗度合い×70%で協議。
      SHORT_RATIO: 0.70,
      SHORT_NOTE:  '⚠15pt未達 (進捗×70%・要協議)',
    },

    // チェックイン対応 (接客担当 = CleaningBoard D列)
    CHECKIN: {
      PRICE_A: 2400,      // チェックイン対応のみ
      PRICE_B: 4800,      // チェックイン対応 + 仕出し対応
      TAX_NOTE: 'チェックイン対応は税抜。登録番号なしのため消費税の取扱いは要協議',

      //  1件の数え方。契約書に「同日に複数組でも1件」と明記されている。
      COUNT_UNIT: 'day',

      //  仕出し(夕食)があるかの判定。
      //
      //  ★食事サマリは「, 」区切りの品目の並びで、表記がそろっていない。
      //    実データの例:
      //      Wagyu Sukiyaki(2人前), Ochazuke Breakfast(2人前)   ← 現行フォーム
      //      朝食 xYes, Chicken Hot Pot Set(2人用), 朝食 x1      ← 旧フォーム
      //      朝食 xYes, Shabu(2人用), 朝食 x2                    ← 旧フォーム(略称)
      //      (paid) Shabu-Shabu(2人前)                          ← Lodgifyアドオン
      //      しゃぶしゃぶ1人前                                   ← CleaningOverride 手書き
      //    判定は品目ごとに行う。まず CONFIG.MEALS のラベルに当て、
      //    当たらなければ下のキーワードで見る。
      //
      //  ★「⚠」以降は自由記述の注記で注文ではない。判定前に切り落とす。
      //    (例: 「朝食 x1 ⚠ I would be interested in the Wagyu set...」を
      //     夕食と誤判定しないため)
      //
      //  朝食は先に判定する。Ochazuke Breakfast を夕食に取り違えないため。
      BREAKFAST_HINTS: [/朝食/, /breakfast/i, /ochazuke/i, /茶漬/],
      DINNER_HINTS: [
        /shabu/i, /sukiyaki/i, /hot\s*pot/i, /chirashi/i, /\bbbq\b/i, /nabe/i,
        /しゃぶ/, /すき焼/, /すきやき/, /牛すき/, /和牛/, /鍋/, /ちらし/, /チラシ/,
        /夕食/, /仕出/, /焼肉/, /弁当/, /ビーグル/, /ビーガン/,
      ],

      //  品目を区切る文字
      ITEM_SEPARATORS: /[,、\/]+/,

      //  注記の始まり (ここから後ろは注文として読まない)
      NOTE_MARKER: '⚠',

      //  ★3つの表のどれか1つでも夕食があれば「仕出しあり」とする
      //    (2026-10 発注者指示)。見る順番や優先はなく、OR で足す。
      //      ① 清掃ボードの食事列(R)
      //      ② LatestOptions の食事サマリ
      //      ③ ほなみや注文確認票 の当月タブ
      //    ③は転記先と同じファイル。Googleスプレッドシート形式に
      //    変換して setOrderExportTargetId() でIDを登録すると効く。
      //    未登録・.xlsx のままなら ③ は黙って見ないだけで、
      //    ①②での判定はそのまま動く。
      USE_ORDER_SHEET: true,

      //  ★清掃ボードの食事列(R)だけでなく LatestOptions も直接見る。
      //    ボードのR列は「フォームの行が滞在に突合できたとき」しか
      //    埋まらないため、突合に失敗した注文を取りこぼす。
      //    チェックイン対応は日単位なので、部屋は問わず同じ日で見る。
      USE_LATEST_OPTIONS: true,

      //  状態(G列)が到着日かどうかの判定
      ARRIVAL_PATTERNS: [/IN/],

      //  W列「接客半日？」に印が付いている日の掛け率。
      //  ★2026-10 発注者指示により無視する (HALF_ENABLED: false)。
      //    契約書にこの列の根拠が無いため。
      //    将来使うことになったら true に戻すだけでよい。
      HALF_ENABLED: false,
      HALF_RATE:    0.5,
      //  印と見なす値。空欄・FALSE・'-'・'なし' は印なし。
      HALF_TRUE_PATTERNS: [/^TRUE$/i, /^(?:yes|y|o)$/i, /^(?:はい|半日|○|◯|●|✓|✔|レ)$/, /^1$/],
    },

    //  誰がどの契約を持っているか。
    //   null を入れた項目は「計算しない」。
    //   未登録の担当者は全項目を計算してログに出す (取りこぼし防止)。
    //  ★まるこ は CleaningBoard の清掃(A列)と接客(D列)の両方に出る。
    //    丸山理恵 の契約(2)は清掃を業務範囲に含まないので、
    //    同一人物なら清掃分は別契約(1)として払う形になる。
    //    別人なら ここで切り分けること。
    //  ★チェックイン対応は まるこ だけの業務ではない。
    //    ゆうｻﾝ・ななみ も D列(接客担当)に入れば同じ単価で計算する。
    //    未登録の担当者は全項目を計算するので、ここは原則空のままでよい。
    //    「この人にはこの業務を払わない」と決めたときだけ false を書く。
    //  給料が発生しない担当者名。
    //
    //   'や' … オーナー本人。自分で清掃・接客に入った日は
    //          清掃ボードに記録されるが、業務委託契約ではないので
    //          給料は発生しない (2026-10 本人確認済み)。
    //
    //  ★作業自体は実在するので黙って消さない。
    //    日数はログの末尾に「オーナー対応 (給与なし)」として出す。
    NO_PAY_NAMES: ['や'],

    CONTRACTS: {
      //  まるこ = 丸山理恵 (2026-10 発注者確認済み)。
      //  契約を2本持っている:
      //    ・柏屋 業務委託契約書(2026) ver3.0 → 清掃セットアップ / 徹底清掃
      //    ・丸山理恵 業務委託契約 別紙1      → チェックイン対応
      //  別紙1が「客室清掃・リネン交換は含まない」としているのは
      //  あくまで別紙1の業務範囲の話で、清掃は ver3.0 側で払う。
      //  よって3項目すべて true。
      'まるこ':   { setup: true, deep: true, checkin: true },
      '丸山理恵': { setup: true, deep: true, checkin: true },
    },

    //  ── ほなみや注文確認票の読み取り設定 ────────────────────
    //   仕出し判定の3つ目の情報源。読むだけで、書き込みは一切しない。
    //   ファイルは ORDER_EXPORT.PROP_TARGET_ID と同じものを使う。
    //
    //   タブは月ごと (「R8　１０月」「R8　９月」「１１月」など)。
    //   表記がそろっていないので、タブ名から
    //     ・令和年 (R8 → 令和8年 → 2026年)
    //     ・月
    //   を拾って対象月のタブを探す。令和年が無いタブ名
    //   (「９月」だけ等) は年が決まらないので対象外にする。
    //   自動で見つからない場合は SHEET_OVERRIDES にタブ名を直接書く。
    //
    //   表の読み方は列の見出しで決める (位置では決めない)。
    //   見出し行から「日付」の列をすべて拾い、それぞれの右側で
    //   最初に見つかる「注文品」の列を組にする。
    //   1階と2階で2組あり、月によって間の空列の数が違うため。
    //   日付セルは品目が複数ある日は空欄になるので、直前の日を引き継ぐ。
    ORDER_SHEET: {
      //  ★まず同じスプレッドシート内のこのタブを見る (2026-10 追加)。
      //    柏屋側で注文確認票を書き写した「一次転記」シート。
      //    同じブックなので変換も権限設定もいらず、そのまま読める。
      //    空文字にすると見ない。
      LOCAL_SHEET_NAME: 'ほなみや一次転記',

      //  一次転記シートはタブ名に年月が入っていない
      //  (タブ名は固定で、中身を毎月入れ替える運用)。
      //  見出し行より上のセルから「R8年9月」のような年月表記を拾う。
      //  拾えなければそのシートは使わない。
      //  ★年月が分からないまま使うと、9月の注文を10月の給料に
      //    付けてしまう。黙って間違えるより使わない方がよい。
      MONTH_CELL_SEARCH_ROWS: 6,

      //  令和1年 = 2019年
      REIWA_BASE_YEAR: 2018,

      //  タブ名から 令和年 と 月 を拾う
      YEAR_PATTERN:  /R\s*(\d{1,2})/i,
      MONTH_PATTERN: /(\d{1,2})\s*月/,

      //  見出しの文字列
      HEADER_DATE:  '日付',
      HEADER_ITEM:  '注文品',
      HEADER_NAME:  '名前',

      //  見出し行を探す範囲 (上から何行目まで見るか)
      HEADER_SEARCH_ROWS: 8,

      //  日付セルから日を拾う ('１日' '10日' '1' どれでも)
      DAY_PATTERN: /(\d{1,2})/,

      //  ── 単位の違い ────────────────────────────────────
      //   食事予約表(LatestOptions) … 人数表記 (2人前 / 4人前)
      //   注文確認票              … セット表記
      //     夕食 1セット = 2名分
      //     朝食 1セット = 1名分
      //   突合するときは必ず人数に揃えてから比べること。
      PERSONS_PER_SET: { dinner: 2, breakfast: 1, other: 1 },

      //  注文確認票の日本語商品名 → 共通ラベル。
      //  ★先頭一致。並び順が効くので、長いもの/限定的なものを上に置く。
      //    「ビーグル冷」を「ビーグル鍋」より先に書くこと。
      ITEM_ALIASES: [
        { test: /^朝食/,                    label: 'Ochazuke Breakfast',       kind: 'breakfast' },
        { test: /^鶏鍋/,                    label: 'Chicken Hot Pot',          kind: 'dinner' },
        { test: /^冷しゃぶ/,                label: 'Cold Shabu-Shabu',         kind: 'dinner' },
        { test: /^豚しゃぶ|^しゃぶしゃぶ/,   label: 'Shabu-Shabu',              kind: 'dinner' },
        { test: /^牛すき|^すき焼/,           label: 'Wagyu Sukiyaki',           kind: 'dinner' },
        { test: /^和牛BBQ|^ＢＢＱ|^BBQ/i,   label: 'Wagyu BBQ',                kind: 'dinner' },
        { test: /^ビーグル冷|^ビーガン冷|^ヴィーガン冷/, label: 'Vegan Cold Shabu-Shabu',   kind: 'dinner' },
        { test: /^ビーグル鍋|^ビーガン鍋|^ヴィーガン鍋/, label: 'Vegan Hot Pot & Chirashi', kind: 'dinner' },

        //  旧フォームの略称。"Shabu(2人用)" のように単語が短い。
        //  ★CONFIG.MEALS のラベルでは当たらないのでここで拾う。
        //    当たらないと品目ごと黙って落ちてしまう。
        { test: /^Shabu\b/i,                label: 'Shabu-Shabu',              kind: 'dinner' },
        { test: /^Sukiyaki\b/i,             label: 'Wagyu Sukiyaki',           kind: 'dinner' },
        { test: /^Chicken\b/i,              label: 'Chicken Hot Pot',          kind: 'dinner' },
        { test: /^Breakfast\b/i,            label: 'Ochazuke Breakfast',       kind: 'breakfast' },
      ],

      //  食事サマリから人数を拾う書き方。
      //   Chicken Hot Pot(3人前) / (2人用) / 朝食 x4 / （１人前）
      //  ★「朝食 xYes」のように数字が無いものは人数不明として扱い、
      //    同じラベルで数字が取れた行があればそちらを採る。
      PORTION_PATTERNS: [
        /[(（]\s*(\d+(?:\.\d+)?)\s*人[前用]\s*[)）]/,
        /\bx\s*(\d+(?:\.\d+)?)\b/i,
      ],

      //  自動で見つからないときに使う対応表。'yyyy-MM': 'タブ名'
      SHEET_OVERRIDES: {
        // '2026-09': 'R8　９月',
      },
    },

    // 契約期間外の月を計算したときに警告を出すための有効期間
    TERMS: {
      SETUP_FROM:   '2026-04-01', SETUP_TO:   '2026-12-31',
      CHECKIN_FROM: '2026-09-01', CHECKIN_TO: '2026-11-30',
    },
  },

  // ── ほなみや注文確認票への転記 v2.22 ───────────────────────
  //  LatestOptions の内容を、ほなみやさんと共有している
  //  「柏屋注文確認票」へ一覧として書き出す。
  //
  //  ★前提: 転記先は Google スプレッドシート形式でなければならない。
  //    元ファイルは .xlsx (Excel) で、Apps Script の SpreadsheetApp は
  //    .xlsx を開けない (openById が例外になる)。
  //    ほなみやさんに「ファイル → Google スプレッドシートとして保存」で
  //    変換してもらい、変換後の**新しいID**を Script Properties に入れる。
  //      setOrderExportTargetId('変換後のID') を1回実行する。
  //    ※IDはコードに書かない (このリポジトリは公開されている)。
  //
  //  ★書き込むのは専用タブ1枚だけ。
  //    月ごとのカレンダー表 (R8　１０月 など) には絶対に触らない。
  //    あちらはほなみやさんが手で書く領域。
  ORDER_EXPORT: {
    ENABLED: true,

    //  転記先スプレッドシートIDを入れる Script Property のキー
    PROP_TARGET_ID: 'ORDER_EXPORT_SHEET_ID',

    //  書き込む先のタブ名。無ければ作る。
    //  ★既存の「R8　9月福田」などに上書きしないよう、別名にしてある。
    SHEET_NAME: '柏屋連携_食事注文',

    //  対象期間。宿泊日が「当月の1日」〜「翌月の末日」の行だけ書く。
    //  MONTHS_AHEAD: 1 = 当月 + 翌月
    MONTHS_AHEAD: 1,

    //  行を書く条件。
    //   'meal_or_option' … 食事サマリ または オプションサマリ がある行
    //   'meal_only'      … 食事サマリ がある行だけ
    //   'all'            … 期間内の全行
    //  ★既定は 'meal_or_option'。既存の「R8　9月福田」タブに
    //    泉屋送迎・Eバイク・荷物預けの行も入っていたため。
    INCLUDE_WHEN: 'meal_or_option',

    //  出力する列の見出し (この順で書く)
    HEADER: ['宿泊日', '曜日', '部屋', '宿泊者名', '人数', '食事', 'オプション', 'その他要望', '更新'],

    //  見出しの下に入れる注意書き (A列に1行)。空文字にすれば出ない。
    NOTICE: '※このタブは柏屋のシステムが毎時書き換えます。手で書いた内容は消えます。',
  },

  // ── 注文確認票への注記 (ORDER_ANNOTATE) ─────────────────────
  //  突合の結果を、注文確認票の「日付セルのメモ」として書き添える。
  //
  //  ★値は絶対に書き換えない。メモ (Range.setNote) だけを使う。
  //    注文確認票の表はほなみやと柏屋が手で書くもの。数量を自動で
  //    直してしまうと、どちらが書いたのか分からなくなる。
  //  ★Apps Script から触れるのは「メモ」まで。返信の付く「コメント」
  //    (スレッド) は SpreadsheetApp では作れない。
  ORDER_ANNOTATE: {
    ENABLED: true,

    //  毎時バッチでも書くか。false ならメニューから手で実行したときだけ。
    IN_BATCH: true,

    //  書く対象の月。0 = 当月だけ / 1 = 当月と翌月
    MONTHS_AHEAD: 1,

    //  メモの中で柏屋が書いた部分の始まりを示す目印。
    //  ★これより前は人が書いたメモとして残す。消すのは目印より後だけ。
    //    目印を変えると古い注記を消せなくなるので変えないこと。
    MARKER: '──────────\n[柏屋 自動突合]',

    //  1つのセルに書くメモの上限 (文字)。長すぎると開くのが重くなる。
    MAX_NOTE_CHARS: 1200,

    //  1回の実行で触るセル数の上限 (暴走よけ)
    MAX_CELLS_PER_RUN: 200,

    //  注記を付けたセルに色を付けるか。
    //  ★既定は false。背景色は人が付けていることがあり、
    //    消すときに元の色へ戻せないため勝手に触らない。
    SET_BACKGROUND: false,
    BACKGROUND: '#fff3cd',
  },

  // ── オプション予約 → Google カレンダー v2.24 ────────────────
  //  E-bikeレンタル / ギアレンタル / 荷物運び / ツアーガイド など、
  //  外部業者に手配する予約を扱う。
  //
  //  流れ:
  //    別スレで確定 → 「オプション予約」シートに1行入る
  //                 → 毎時バッチが Google カレンダーに予定を作る
  //
  //  ★シートは人(または別スレ)が書く領域。GASが書くのは
  //    K列(登録日時) と L列(イベントID) の2列だけ。
  //  ★J列「状態」が起点。
  //      確定 … カレンダーに登録する (既にあれば内容を更新する)
  //      取消 … 登録済みの予定を削除する
  //      空欄 … 何もしない (下書き)
  OPTION_BOOKING: {
    ENABLED: true,
    SHEET:   'オプション予約',

    //  カレンダーIDを入れる Script Property のキー。
    //  ★IDはコードに書かない。setOptionCalendarId('...') で1回登録する。
    PROP_CALENDAR_ID: 'OPTION_CALENDAR_ID',

    //  Script Property が未設定のときに使うカレンダー。
    //   'primary' … 実行ユーザーのメインカレンダー
    //   ''        … 使わない (未設定ならスキップする)
    //  ★専用カレンダーに分けたくなったら setOptionCalendarId() で
    //    そのIDを登録する。登録した方が常に優先される。
    DEFAULT_CALENDAR_ID: 'primary',

    //  状態の文字
    STATUS_FIXED:  '確定',
    STATUS_CANCEL: '取消',

    //  1回のバッチで作る予定の上限 (暴走よけ)
    MAX_PER_RUN: 50,

    //  開始か終了の片方しか決まらないときに使う所要時間 (分)。
    //  ★「9時集荷」のように開始だけ書かれることがある。
    //    そのまま終日にすると、書いた時刻が予定に出ずに意味が消える。
    DEFAULT_DURATION_MIN: 60,

    //  区分ごとの既定時刻。E列/F列が空のときに使う。
    //  null を入れると終日の予定にする。
    //  ★Beyond Nakasendo Cycling は
    //    チェックイン日10:00 〜 チェックアウト日15:00 が受付時間。
    KINDS: [
      { test: /E\s*-?\s*バイク|e\s*-?bike/i, label: 'Eバイク',     start: '10:00', end: '17:00' },
      { test: /ギア|gear/i,                   label: 'ギアレンタル', start: '10:00', end: '17:00' },
      { test: /荷物|バゲ|baggage|luggage/i,    label: '荷物運び',     start: null,    end: null    },
      { test: /ガイド|ツアー|guide|tour/i,     label: 'ツアーガイド', start: '09:00', end: '12:00' },
      { test: /泉屋/,                         label: '泉屋送迎',     start: '17:30', end: '18:00' },
      { test: /タクシー|taxi/i,               label: 'タクシー',     start: null,    end: null    },
    ],

    //  予定のタイトル。{区分} {数量} {名前} {部屋} {業者} を差し替える。
    TITLE: '{区分}{数量} {名前}{部屋}',

    //  カレンダーの色 (CalendarApp.EventColor の名前)。空なら既定色。
    COLOR: '',
  },

  // オプション予約シートの列
  COL_OPTBK: {
    DATE:       1,   // A 実施日
    KIND:       2,   // B 区分 (Eバイク / ギアレンタル / 荷物運び / ツアーガイド)
    GUEST_NAME: 3,   // C 宿泊者名
    ROOM:       4,   // D 部屋
    START:      5,   // E 開始時刻 (空なら区分の既定、それも無ければ終日)
    END:        6,   // F 終了時刻
    QTY:        7,   // G 数量
    VENDOR:     8,   // H 業者
    MEMO:       9,   // I メモ
    STATUS:    10,   // J 状態 (確定 / 取消 / 空)  ★ここが起点
    SYNCED_AT: 11,   // K 登録日時   ★GASが書く
    EVENT_ID:  12,   // L イベントID ★GASが書く
  },
  OPTBK_WIDTH: 12,

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

/**
 * ほなみや注文確認票 (Googleスプレッドシート形式に変換したもの) の
 * IDを Script Properties に保存する。
 *
 *  ★このリポジトリは公開されているため、IDをコードに書かない。
 *    エディタから一度だけ
 *      setOrderExportTargetId('1AbC...')
 *    を実行し、実行後はこの呼び出しを消すこと。
 *
 *  IDは変換後ファイルのURLの
 *    docs.google.com/spreadsheets/d/【ここ】/edit
 *  の部分。★.xlsx のままのURL (drive.google.com/file/d/...) ではない。
 */
function setOrderExportTargetId(id) {
  if (!id) throw new Error('IDが空です');
  const clean = String(id).trim();
  if (/^https?:/i.test(clean)) {
    throw new Error('URLではなくID部分だけを渡してください (/d/ と /edit の間)');
  }
  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.ORDER_EXPORT.PROP_TARGET_ID, clean);
  Logger.log('転記先スプレッドシートIDを保存しました。');
}

/**
 * オプション予約を入れる Google カレンダーのIDを保存する。
 *
 *  カレンダーIDは Google カレンダーの
 *    設定 → (カレンダー名) → カレンダーの統合 → カレンダーID
 *  にある文字列 (xxxx@group.calendar.google.com など)。
 *  自分のメインカレンダーなら 'primary' でもよい。
 *
 *  ★このリポジトリは公開なのでIDをコードに書かない。
 *    エディタから一度だけ実行し、実行後は呼び出しを消すこと。
 */
function setOptionCalendarId(id) {
  if (!id) throw new Error('カレンダーIDが空です');
  PropertiesService.getScriptProperties()
    .setProperty(CONFIG.OPTION_BOOKING.PROP_CALENDAR_ID, String(id).trim());
  Logger.log('オプション予約のカレンダーIDを保存しました。');
}

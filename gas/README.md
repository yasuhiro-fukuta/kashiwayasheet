# 柏屋 予約同期 (Kashiwaya Reservation Sync) v2.14

Google スプレッドシート + Apps Script。Booking.com / Airbnb の iCal、
Lodgify Public API、Google フォームから宿泊者情報を集め、
**清掃予定表 (CleaningBoard)** と **食事予約表 (LatestOptions)** を作る。

---

## v2.10 で直した不具合

### 1. Lodgify 直予約の情報が取れない

**症状**: 自社予約ページ・Lodgify 管理画面から入った予約が清掃ボードに出ず、
実際には客がいる部屋が「空室」と表示される。

**原因**: Lodgify API からの取得自体は成功していた。落ちていたのは取得後の突合。
清掃ボードの在室骨格を `LatestReservations` (= Booking.com / Airbnb の iCal) だけから
作っており、`LodgifyBookings` は「その骨格に人数を後から載せる」用途にしか
使われていなかった。直予約はどの OTA の iCal にも現れないので、
骨格に行が無い = board にも出ない。

実データ (2026-09-02 時点) で確認した取りこぼし:

| 宿泊日 | 部屋 | 宿泊者 | 人数 | 修正前の表示 |
|---|---|---|---|---|
| 2026-11-24 | 2F | Gloria Cereda | 2 | OUT→空室 |
| 2026-11-25 | 2F | Michael Conor Cook | 2 | 空室 |
| 2027-03-31 | 1F | Amanda McLaughlin | 3 | 空室 |

**対策**: `CleaningBoard.gs` の `mergeLodgifyStays()` を追加。
iCal が押さえていない「夜」だけを拾って骨格に合流させる。

- 判定は **夜単位**。直予約でも Booking.com が `CLOSED` ブロックを出していれば
  iCal に夜が存在するので、その場合は従来どおり iCal の行に人数と氏名だけを載せる。
  **二重計上はしない。**
- 合流した行の備考には「直予約」と出る。
- OTA 予約なのに未来の夜が iCal に無い場合は
  「⚠iCal未掲載 (取得もれの可能性)」と出す。iCal 取得障害の早期発見用。
  (過去の夜は iCal が配信しないので無印)

### 2. 食事予約表の人数が取れないことがある

**症状**: `LatestOptions` の G列 (人数) が空欄のまま。

**原因**: 現行の Google フォームに人数設問が無い。
`Number of guests` は旧フォーム (21列目 / 28列目) にしか存在せず、
現行フォームからの回答では常に空欄になる。
実データでは有効44行のうち **23行** が空欄だった。

**対策**: `GuestCount.gs` の `backfillOptionGuests()` を追加。
毎バッチ、G列の空欄だけを次の優先順で埋める。

1. Lodgify API (権威データ)
2. 食事サマリの「N人前 / N人用」の最大値からの推定

すでに値が入っている行と、論理削除済みの行には触らない。
書き込むのは G列だけで、M列の曜日数式や L列「ほなみや転記済」には一切触れない。

実データでの結果: **23行中 21行を Lodgify から、2行を食事推定から補完し、未解決 0**。

### あわせて直した細かい不具合

| 箇所 | 内容 |
|---|---|
| `LodgifyFetcher.gs` | upsert キーが「解決後の部屋 (1F/2F)」だったため、`ROOM_MAP` を直すと同じ予約が別行として増え、古い行に「削除」が立っていた (実際に 149行まで膨張)。キーを `room_type_id` ベースの安定値に変更 |
| `GuestCount.gs` | 人数突合が `Array.find()` の先頭一致で、期間が重なる予約が複数あると行順まかせだった。`findLodgifyBooking()` に統一し、チェックイン完全一致 → 直近の重なり の順で選ぶ |
| `Utils.gs` | 全角数字 (`"１人前"` が実データに存在) で人数推定が 0 になっていた。`toHalfWidth()` を通してから解析 |
| `CleaningBoard.gs` | 連泊の中日の日付でフォームが出されると食事が丸ごと落ちていた。滞在期間内の日付も拾うようにした |
| `CleaningBoard.gs` | 毎行 `stays.filter()` を3回まわしていたのを日付×部屋の索引に変更 |
| `Main.gs` | 処理順を変更。Lodgify 取得をフォーム同期より **前** に移した。旧順序では人数補完が常に1バッチ前の Lodgify を見ることになり、当日入った予約の人数が1時間遅れていた |
| `IcalFetcher.gs` | 継続行 (先頭が空白) が iCal の1行目に来た場合に落ちる可能性があった |
| `ReservationSync.gs` | 引数の `now` を無視して内部で `nowJst()` を呼び直しており、バッチ内で時刻が食い違っていた |

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `Config.gs` | 全設定。列定義、iCal URL、ROOM_MAP、食事/オプションの対応表 |
| `Main.gs` | エントリポイント、毎時トリガー、カスタムメニュー |
| `IcalFetcher.gs` | Booking.com / Airbnb の iCal 取得とパース |
| `ReservationSync.gs` | 予約同期と消失(キャンセル)検知 |
| `LodgifyFetcher.gs` | Lodgify Public API v2 の取得と `LodgifyBookings` への upsert |
| `LodgifyAddons.gs` | **Lodgify 予約時オプション(アドオン)の取込** (v2.14 新規) |
| `OptionSync.gs` | フォーム回答の取込、食事/オプションサマリ生成 |
| `GuestCount.gs` | **人数解決の共通ロジック** (v2.10 新規) |
| `CleaningBoard.gs` | 清掃予定表の生成 |
| `CheckinForm.gs` | **Check-In Form (宿泊者名簿) の取込** (v2.10.3 新規) |
| `Staff.gs` | 担当者一覧の自動生成 (v2.11 新規) |
| `Consistency.gs` | **手動入力の矛盾チェック → 指摘事項シート** (v2.13 新規 / v2.14 で区間判定に作り直し) |
| `Diagnose.gs` | 突合が合わないときの原因切り分け |
| `Utils.gs` | 日付・全角変換などの共通処理 |

---

## 反映手順

1. Apps Script エディタで各ファイルの中身を差し替える。
   **`GuestCount.gs` は新規ファイル**なので追加すること。
2. スプレッドシートを開き直してメニュー「🏮 柏屋」を再読み込み。
3. 「🏨 Lodgify取得だけ実行」→「🧹 清掃ボードだけ再生成」の順に手動実行して確認。
4. 「🩺 直予約・人数の突合診断」でログを確認する。

`addDaysStr()` と `numOrZero()` は `Utils.gs` に集約した。
`CleaningBoard.gs` / `LodgifyFetcher.gs` に残っている旧定義があれば消すこと
(Apps Script は同名関数を後勝ちで上書きするため、重複すると事故のもとになる)。

### 3. 直予約が「期間外」でボードに出ない (v2.10.1)

`CONFIG.CLEANING.DAYS_AHEAD` が 120 だったため、半年〜1年先に入った直予約は
ボードに行そのものが生成されず、「API では取得できているのに見えない」状態に
なっていた。実データで Amanda McLaughlin (2027-03-31) と
Dragan Sekulic (2027-03-29〜30 / 04-01) の4泊が該当。

**400 に変更した。** 2026-08-01 起点で約870行になる。
`START_DATE` は固定なので行は下に伸びるだけで、既存行の位置は動かない
(検証: `2026-11-24_2F` はシート233行目のまま)。
あわせて `setupCleaningFormatting` の色付け範囲が 2000行 固定だったのを
実際の行数から決めるようにし、`renderCleaningRows` の安全弁 (guard) も広げた。

### 4. Check-In Form 未提出の警告 (v2.10.2 / 参照先を v2.10.3 で修正)

チェックイン日が「今日 - `DAYS_AGO`」なのに Check-In Form の記入が
無い滞在について、清掃ボードの **E列(キー)を赤字**にする。
既定は `DAYS_AGO: 1` = 昨日到着分。

**★フォームが2種類あることに注意。**

| | 中身 | 置き場所 |
|---|---|---|
| `FormResponses` → `LatestOptions` | 食事の注文、泉屋送迎・荷物・タクシー等 | マスターと同じブック |
| **Check-In Form** | 代表者氏名 / 住所 / 職業 / 電話番号 (宿泊者名簿) | **別スプレッドシート** |

v2.10.2 では誤って前者 (食事フォーム) を見ていた。食事を注文していれば
宿泊者名簿が未提出でも「提出済み」と判定されてしまうため、
v2.10.3 で `CheckinForm.gs` を新設し後者を見るように直した。

- 場所は `CONFIG.CHECKIN_FORM` に設定する (`SPREADSHEET_ID` / `SHEET_NAME`)。
- 列は**見出し名**で探す。フォームに設問を足して列がずれても壊れない。
- 突合キーは (Check-in Date, Room Name)。`Room Name` は
  "1st floor" / "2nd floor" で入るので `normalizeRoom()` が 1F / 2F に解決する。
  氏名の表記ゆれ ("Mitchell seach" と "Seach Mitchell" 等) は突合に影響しない。
- **文字色は `buildCleaningBoard` を実行したときにだけ塗り直される。**
  コードを新しくしただけでは古い赤は消えない。判定が変わったのに
  赤が残っている場合は、まずバッチを1回流すこと。
  `explainRedKeys()` が「いま塗るべきか」をセルごとに教えてくれる。
- **フォームを読めない場合 (ID誤り・権限なし) は赤字を一切付けない。**
  全員を未提出扱いにして誤って催促するより安全側に倒す。
  `dumpCheckinForm()` で読めているか確認できる。
- **書式はバッチのたびに E列全体を既定色へ戻してから付け直す。**
  戻さないと、フォームが後から提出されても赤いままになる。
  値の書き込み (`writeCleaningBoard`) は書式を変えないため、
  ここで明示的に戻す必要がある。
- 色は濃い赤 (`#A50E0E`) + 太字。状態が「OUT→IN」の行は条件付き書式で
  背景が赤系 (`#FF7C80`) になるため、明るい赤だと読めなくなる。
- 設定は `CONFIG.CHECKIN_FORM_ALERT`。`ENABLED: false` で無効化、
  `DAYS_AGO` を 2, 3 と増やすとその日数分さかのぼって対象になる。
- `listPendingCheckinForms()` で未提出者の一覧だけをログに出せる
  (書き込みなし)。メニューにも「📋 Check-In Form 未提出を一覧」がある。

---

## テスト

| 関数 | 内容 |
|---|---|
| `selfTest()` | **書き込みなし**。関数の存在・**版**・単体ロジック・シート・Lodgify取得・合流結果・人数充足率を1回で確認 |
| `verifyCleaningBoardWrite()` | 実際に読み→書き→読み直して BEFORE/AFTER を並べる。書き込むのは E列以降のみ |
| `diagnoseLodgifyMatch()` | 突合が合わないときの原因切り分け |
| `listPendingCheckinForms()` | Check-In Form 未提出者の一覧。**書き込みなし** |
| `dumpCheckinForm()` | Check-In Form が読めているかの確認。**書き込みなし** |
| `explainRedKeys()` | E列の赤字の出どころを特定する。**書き込みなし** |
| `runConsistencyCheckOnly()` | 手動列の矛盾チェック。指摘事項シートに追記する |
| `dumpLodgifyAddons()` | **予約時オプションが API のどこに入っているかを確認する。書き込みなし** |
| `runLodgifyAddonSyncOnly()` | 予約時オプション → 食事予約表 の反映だけを実行する |

`selfTest` の **[1b]** は `Function.prototype.toString()` で関数のソースを見て、
新版の目印 (呼び出しの形) が含まれるかを判定する。
これが無かったため「selfTest は全部OKなのに清掃ボードが書き換わらない」を
一度取りこぼした。旧ファイルが残って同名関数を後勝ちで上書きしている場合、
[1] の存在チェックだけでは検出できない。

---

## Lodgify 予約時オプション (アドオン) — v2.14

Lodgify のチェックアウト画面で食事を売り始めた。

```
Dinner - Chicken Hot Pot for 2   ¥6,000
Dinner - Chicken Hot Pot for 3   ¥8,000    ← "x1" で ¥8,000 / 1滞在あたり
```

これまで食事の注文経路は GoogleForm だけだったので、
Lodgify で頼まれた食事は誰も気付かないまま当日を迎えてしまう。

### 何をしているか

GoogleForm の食事オプションと**同じ扱い**にしている。
つまり `LatestOptions` (食事予約表) に行を作る。
ここに乗れば既存の経路がそのまま効く:

- ほなみやへの発注一覧 (この表がそのまま発注元)
- `applyOptionsInfo()` 経由で CleaningBoard の食事列 (R) にも出る
- 条件付き書式・曜日数式・並べ替えも共通

```
Lodgify API ─ syncLodgifyBookings()      → LodgifyBookings T列 (予約時オプションJSON)
            └ syncLodgifyMealOptions()   → LatestOptions に1行 (フォーム行と同じ形)
                                         → buildCleaningBoard() で食事列に反映
```

| 列 | 入る値 |
|---|---|
| C 送信日時 | 初回取得日時 (注文日時のかわり。毎バッチ変わらないので行が揺れない) |
| D 宿泊日 | チェックイン日 |
| E 部屋 | 1F / 2F |
| F 宿泊者名 | Lodgify の宿泊者名 |
| G 人数 | Lodgify の人数 (空なら `backfillOptionGuests()` が後で埋める) |
| H 食事サマリ | `Chicken Hot Pot(3人前)` — フォーム由来と同じ書式 |
| I オプションサマリ | 食事以外のアドオン (`Late check-out` など) |
| J その他要望 | `Lodgify予約時オプション` (出所タグ) |
| K 原文JSON | `{"_source":"lodgify","_booking_id":…,"addons":[…]}` |
| L ほなみや転記済 | **書かない** (手動列) |

### 気を付けた点

- **フォーム行と殺し合わせない。**
  `markOlderAsResubmitted()` は (宿泊日, 部屋, 宿泊者名) が同じ古い行を
  「削除」にする。素で入れると
  「Lodgifyで夕食 + フォームで朝食」を頼んだ客のフォーム行が毎バッチ消える。
  → `optKey()` を出所込みにした。アドオン行は予約IDまでキーに含めるので、
  こちらの重複排除は一切触らない。生死は `syncLodgifyMealOptions()` の
  upsert が予約IDで管理する。
- **列を増やしていない。**
  出所は K列 (原文JSON) の `_source` に入れた。列を足すと L列
  「ほなみや転記済」と M列の曜日数式がずれる。
- **清掃ボードの食事列は合算するようにした。**
  `applyOptionsInfo()` は (宿泊日, 部屋) ごとに最新1行だけを採っていた。
  Lodgify で夕食・フォームで朝食のように生きている行が2つある場合、
  片方の注文が食事列から消える。→ 食事・オプション・要望は合算する。
  実データ127滞在で旧実装と差分0件 (合算が効くのは複数行あるときだけ)。
- **1予約で2部屋のときはアドオンを先頭の部屋にだけ載せる。**
  どちらの部屋の食事かは API からは判らない。両方に載せると二重発注になる。
  該当時はログに出すので `CleaningOverride` で調整する。
- **人前は `for N` × 個数。**
  `Dinner - Chicken Hot Pot for 3` x1 → 3人前 / `for 2` x2 → 4人前。
  同じ料理が2件あれば人前を合算する (`for 2` + `for 3` → 5人前)。
- **内容が変わっていない行は1セルも書かない。** A列の更新日時が揺れない。
- **消えたアドオンは論理削除。** 物理削除しないので過去実績が残る。
  再び現れたら「削除」を外して復活させる。

### ★フィールド名が未確定

Lodgify の公開ドキュメントにアドオンの項目が無く、
実レスポンスで確かめる以外の確認手段が無かった。
そのため取り出しは2段構えにしている (`CONFIG.LODGIFY.ADDONS`)。

1. `KEYS` に挙げた名前の配列 (`add_ons` / `addons` / `addOns` /
   `booking_add_ons` / `add_on_items` / `extras`) があれば**無条件に採用**。
   ネストしていても拾う。キー名の綴り・大文字小文字・区切り文字は無視する。
2. 無ければ JSON を再帰走査し、「名前らしき文字列 + 個数か金額」を持つ物を
   候補にする。ただし**食事名に一致した候補しか採用しない**
   (料率明細・税・入金を誤ってアドオンにしないため)。

**最初にやること: メニュー「🍱 Lodgify アドオン確認」(`dumpLodgifyAddons`)。**
ログに次が出る。

- booking のトップレベルキーと `rooms[]` のキーの一覧
- アドオンを持つ予約と、その取り出し経路 (`KEYS:` か `SCAN:` か)
- 1件も取れなかった場合は生JSONの先頭4000字

`SCAN:` で拾っていたら、出ているパス名の配列名を
`CONFIG.LODGIFY.ADDONS.KEYS` に足すこと。1) の経路に変わり、
食事以外のアドオンも取りこぼさなくなる。

0件だった場合はリスト取得のレスポンスにアドオンが含まれていない。
Lodgify サポートに
「`GET /v2/reservations/bookings` のレスポンスにアドオンを含める
パラメータはあるか」を確認する
(`stayFilter` のときと同じで、綴りを誤ると黙って既定に落ちる仕様なので
返答の表記に厳密に合わせること)。

---

## 既知の制限

- Airbnb 経由の予約は Lodgify に入らないため人数が取れない。
  該当行は備考に「⚠人数不明 → CleaningOverride に記入」と出る
  (実データでは 2026-10-14 1F の1件)。
- `CONFIG.CLEANING.START_DATE` は固定。ここを変えると A〜D列の手動入力が
  日付とずれるので変更しないこと。
- 清掃ボードは毎バッチ E列以降を全消しして書き直す。
  手入力は必ず A〜D列か `CleaningOverride` 側に行うこと。
- Lodgify 予約時オプションのフィールド名は**実レスポンス未確認**。
  まず `dumpLodgifyAddons()` を実行して確認すること (上記参照)。
- 1予約で2部屋押さえた予約のアドオンは先頭の部屋にだけ載る。
  どちらの部屋の食事かは API から判らないため。

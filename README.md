# 柏屋 予約同期 (Kashiwaya Reservation Sync)

Google スプレッドシート `kashiwaya_master_v2` に紐づく Apps Script。
Booking.com / Airbnb の iCal、Lodgify Public API、Google フォームから
宿泊者情報を集め、**清掃予定表 (CleaningBoard)** と
**食事予約表 (LatestOptions)** を作る。

コードは `gas/` に置き、**clasp** で Apps Script へ反映する。
`main` に push すると GitHub Actions が自動で反映する。

コードの中身・各ファイルの役割・修正履歴は **[gas/README.md](gas/README.md)** を参照。

---

## 初回セットアップ

手でコピペする運用をやめるための手順。1回だけやればよい。

### 1. Apps Script API を有効にする

<https://script.google.com/home/usersettings> を開き
「Google Apps Script API」を **オン** にする。既定はオフ。

### 2. clasp を入れてログインする

```bash
npm install -g @google/clasp@3.4.1
clasp login
```

> **Windows (PowerShell) で `npm` が実行できない場合**
>
> `npm : このシステムではスクリプトの実行が無効になっているため、
> ファイル ...\npm.ps1 を読み込むことができません` と出るときは、
> PowerShell の実行ポリシーが `.ps1` をブロックしている。
> npm や Node の問題ではない。管理者権限は要らない。
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```
>
> ポリシーを変えたくない場合は `.ps1` を経由しない `.cmd` を直接呼ぶ
> (`npm.cmd i -g ...` / `clasp.cmd login`)。ただし clasp も同じシムを
> 持つので、以降ずっと `.cmd` を付け続けることになる。

ブラウザが開くので、スプレッドシートの持ち主のアカウントで許可する。
成功すると `~/.clasprc.json` ができる。

> バージョンを固定しているのは、clasp が v2 → v3 で認証まわりの仕様を
> 変えているため。`latest` にすると突然動かなくなることがある。

### 3. スクリプトIDを調べる

Apps Script エディタ → ⚙ **プロジェクトの設定** → **スクリプトID** をコピー。
スプレッドシートのIDとは別物なので注意。

### 4. マニフェストを取り込む

`clasp push` は `gas/appsscript.json` が無いと失敗する。
**手で作らず、必ず実物を取ってくること。**
タイムゾーンや権限スコープが実際のプロジェクトとずれると、
日付の判定が1日ずれるなど分かりにくい壊れ方をする。

`clasp clone` は **カレントディレクトリにファイルを作る**。
`C:\WINDOWS\system32` などで実行しないこと。

```bash
# 既存コードを壊さないよう、まず別の場所へ落とす
mkdir -p /tmp/gaspull && cd /tmp/gaspull      # Windows: cd ~\Documents; mkdir gaspull; cd gaspull
clasp clone <スクリプトID>

# マニフェストだけをリポジトリへ持ってくる
cp appsscript.json <このリポジトリ>/gas/appsscript.json
```

`gas/appsscript.json` をコミットする。

> `clasp clone` は既存ファイルを上書きする。
> このリポジトリの中で直接実行しないこと。

### 5. ローカルから反映してみる

リポジトリ直下に `.clasp.json` を作る（`.clasp.json.example` をコピーして
スクリプトIDを埋める）。このファイルは `.gitignore` 済み。

```bash
cp .clasp.json.example .clasp.json
# scriptId を書き換える
clasp push -f
```

Apps Script エディタを再読み込みして、ファイルが揃っていれば成功。

### 6. GitHub Actions から自動反映できるようにする

リポジトリの **Settings → Secrets and variables → Actions** に2つ登録する。

| シークレット名 | 中身 |
|---|---|
| `CLASPRC_JSON` | `~/.clasprc.json` の中身をそのまま貼る |
| `SCRIPT_ID` | 手順3のスクリプトID |

以降、`gas/` を変更して `main` に push すれば自動で反映される。
**Actions タブ → Deploy Apps Script → Run workflow** で手動実行もできる。

> `CLASPRC_JSON` はリフレッシュトークンそのもの。これを持つと
> Apps Script と Drive を操作できる。リポジトリを公開する場合は特に注意。
> 漏れた疑いがあれば <https://myaccount.google.com/permissions> から
> clasp のアクセスを取り消し、`clasp login` をやり直す。

---

## ふだんの流れ

```bash
git pull
# gas/ を編集
git commit -am "説明"
git push          # main なら Actions が自動で反映
```

反映後は Apps Script エディタで `selfTest` を実行して確認する
（シートに書き込まない自己診断）。

---

## 困ったとき

| 症状 | 対処 |
|---|---|
| Actions が `User has not enabled the Apps Script API` で失敗 | 手順1をやる |
| Actions が認証で失敗するようになった | トークンが失効した可能性。`clasp login` をやり直して `CLASPRC_JSON` を入れ直す |
| `gas/appsscript.json がありません` で失敗 | 手順4をやる |
| PowerShell で `npm.ps1 を読み込むことができません` | 実行ポリシー。手順2の注記を参照 |
| `clasp clone` が `User has not enabled the Apps Script API` | 手順1をやる |
| 反映したのにシートの表示が変わらない | Apps Script に入っただけ。バッチ (`runBatch` など) を1回流す |
| E列の赤字が意図と違う | `explainRedKeys()` を実行する |

診断関数の一覧は [gas/README.md](gas/README.md#テスト) にある。

---

## 構成

```
.
├── gas/                       Apps Script のソース (clasp の rootDir)
│   ├── appsscript.json        マニフェスト ※手順4で取り込む
│   ├── Config.gs              全設定
│   ├── Main.gs                エントリポイント・毎時トリガー・メニュー
│   └── ...                    詳細は gas/README.md
├── .clasp.json.example        scriptId を埋めて .clasp.json にコピーする
├── .claspignore               Apps Script に送らないファイル
└── .github/workflows/
    └── deploy-apps-script.yml main への push で自動反映
```

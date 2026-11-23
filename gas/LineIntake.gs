/**
 * ============================================================
 *  LineIntake.gs - 社長の個人LINEの通知を「LINE受信」タブに入れる  v1.00 (2026-11-23)
 * ============================================================
 *  社長決定 2026-11-23 16:37「ワッツアップで同じやり方で拾えよ」:
 *  スタッフ（清掃のYukAさん、理恵さん等）・取引先から社長の個人LINEに届く
 *  メッセージを、WhatsApp と同じく スマホの MacroDroid が通知を拾って
 *  HTTP POST し、このブックの「LINE受信」タブに1行ずつ入れる。
 *  お客様の DM台帳 とは分ける（スタッフ・取引先の連絡が混ざるため）。
 *  社長室・定時チェック（6・12・18時）が「未処理」の行を読み、返事の案と
 *  社長の判断事項を出す。
 *
 *  受け口（MacroDroid から）:
 *    POST <書き込みAPIと同じウェブアプリURL>?src=line&key=<LINE用の鍵>
 *    本文は JSON でもフォーム形式でもよい。読む項目（どれか1つあればよい）:
 *      title … 通知のタイトル（1対1＝相手の名前、グループ＝グループ名のことが多い）
 *      text  … 通知の本文（グループでは「送信者: 本文」のことが多い）
 *      sub   … 通知のサブテキスト（あれば。グループ名が入る機種がある）
 *      app   … アプリ名（任意。LINE 以外は受けない）
 *    返り値: {ok:true, added:1} / {ok:true, skipped:'…'} / {ok:false, error:'…'}
 *
 *  ★鍵は書き込みAPIの合言葉とは別。書き込みAPIの合言葉（何でも書ける）を
 *    スマホに置かないため。LINE用の鍵で出来るのは「LINE受信」に1行足すことだけ。
 *    鍵の本体はコードにもスクリプトプロパティにも置かず、SHA-256 だけを
 *    スクリプトプロパティ LINE_INTAKE_KEY_SHA256 に置く（line.setup で設定）。
 *    鍵の本体は Drive「O_メッセージ受付_運用手順とシート書き込みAPI」にだけ書く。
 *
 *  Claude から（書き込みAPI。合言葉 token が要る）:
 *    line.setup     {key}                       鍵を設定（SHA-256だけ保存）・タブを用意
 *    line.status    {}                          鍵の有無・行数・未処理件数・最後の受信
 *    line.list      {status?, since?, limit?}   行を読む（既定：処理状態=未処理、新しい順に最大100）
 *    line.setStatus {row, status, memo?}        E列(処理状態)を変え、F列(社長室メモ)に追記
 *    line.off       {}                          鍵を消す（受け口を止める。行は残す）
 *
 *  使う Google のサービス: SpreadsheetApp・PropertiesService・CacheService・Utilities
 *  （既存のコードで使っている範囲だけ。新しい権限の承認は要らない）
 * ============================================================
 */

const LINE_SHEET_ = 'LINE受信';
const LINE_HEADER_ = ['受信日時', '送信者名', 'トーク名', '本文', '処理状態', '社長室メモ'];
const LINE_WIDTHS_ = [130, 140, 160, 520, 90, 320];
const LINE_STATUSES_ = ['未処理', '対応中', '済', '対象外'];
const LINE_PROP_KEY_ = 'LINE_INTAKE_KEY_SHA256';
const LINE_DEDUP_SEC_ = 30 * 60;   // 同じ通知が30分以内にもう一度来たら入れない
const LINE_BODY_MAX_ = 5000;

// ------------------------------------------------------------
//  純粋関数（シートにもネットにも触らない。test/line-intake.test.js で検証）
// ------------------------------------------------------------

/** 改行・空白をそろえる（改行は残す。長すぎる本文は切る） */
function lineClean_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t 　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, LINE_BODY_MAX_);
}

/**
 * MacroDroid から届いた中身を {title, text, sub, app} にそろえる。
 *  params … e.parameter（URL のクエリ＋フォーム本文）
 *  raw    … e.postData.contents（JSON なら読む）
 */
function lineParseInput_(params, raw) {
  const p = params || {};
  let j = {};
  const s = String(raw || '').trim();
  if (s && s.charAt(0) === '{') {
    try { j = JSON.parse(s) || {}; } catch (err) { j = {}; }
  }
  const pick = (...names) => {
    for (const n of names) {
      if (j[n] !== undefined && j[n] !== null && String(j[n]) !== '') return String(j[n]);
      if (p[n] !== undefined && p[n] !== null && String(p[n]) !== '') return String(p[n]);
    }
    return '';
  };
  let text = pick('text', 'body', 'message', 'notification');
  // JSON でもフォームでもない生の本文だけが来たとき
  if (!text && s && s.charAt(0) !== '{' && s.indexOf('=') < 0) text = s;
  return {
    title: lineClean_(pick('title', 'name', 'sender')).slice(0, 200),
    text: lineClean_(text),
    sub: lineClean_(pick('sub', 'subtext', 'group', 'talk')).slice(0, 200),
    app: lineClean_(pick('app', 'app_name', 'package')).slice(0, 100),
  };
}

/** 入れなくてよい通知（まとめ通知・LINE自身の案内）なら理由を返す。入れるなら '' */
function lineNoiseReason_(m) {
  const t = String(m.title || '');
  const x = String(m.text || '');
  if (m.app && !/line|jp\.naver\.line/i.test(m.app)) return 'LINE以外のアプリ';
  if (!x) return '本文なし';
  if (/^\d+\s*件の(新着)?メッセージ/.test(x) || /^新着メッセージがあります/.test(x)) return 'まとめ通知';
  if (/^\d+\s*new messages?$/i.test(x)) return 'まとめ通知';
  if ((t === '' || t === 'LINE') && /(同期|バックグラウンド|接続中|通信中)/.test(x)) return 'LINEの案内';
  return '';
}

/**
 * タイトル・本文から {talk, sender, body} を取り出す。
 *  - sub があれば：トーク名＝sub、送信者＝title（グループ名がサブテキストに入る機種）
 *  - 本文が「名前: 本文」「名前：本文」なら：トーク名＝title、送信者＝名前（グループ）
 *  - それ以外：1対1。トーク名＝送信者＝title
 *  ★グループの見分けは推測。最初の数件を見て合わなければここを直す。
 *    本文(body)はどの場合も通知の本文をそのまま入れる。
 */
function lineSplit_(m) {
  const title = String(m.title || '');
  const text = String(m.text || '');
  if (m.sub && m.sub !== title) {
    return { talk: m.sub, sender: title, body: text };
  }
  const mm = /^([^\n:：]{1,40}?)\s*[:：]\s*([\s\S]+)$/.exec(text);
  if (mm && title && mm[1].trim() !== title && !/^https?$/i.test(mm[1].trim())) {
    // 本文は元のまま残す（見分けを間違えても中身を失わないように）
    return { talk: title, sender: mm[1].trim(), body: text };
  }
  return { talk: title, sender: title, body: text };
}

/** 重複判定のキー（同じトーク・同じ送信者・同じ本文） */
function lineDedupKey_(r) {
  return [r.talk, r.sender, r.body].join('\u0001');
}

/** 書き込む1行（受信日時は文字列。ブックのタイムゾーンが太平洋時間のため Date を書かない） */
function lineRow_(r, receivedStr) {
  return [receivedStr, r.sender, r.talk, r.body, '未処理', ''];
}

/** 文字列の SHA-256（16進） */
function lineSha256Hex_(s) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return d.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

// ------------------------------------------------------------
//  受け口（WriteApi.gs の doPost から ?src=line のときに呼ばれる）
// ------------------------------------------------------------

function lineIntake_(e) {
  const params = (e && e.parameter) || {};
  const want = PropertiesService.getScriptProperties().getProperty(LINE_PROP_KEY_);
  if (!want) return { ok: false, error: 'line intake off' };
  if (!params.key || lineSha256Hex_(params.key) !== want) return { ok: false, error: 'unauthorized' };

  const m = lineParseInput_(params, e && e.postData && e.postData.contents);
  const noise = lineNoiseReason_(m);
  if (noise) return { ok: true, skipped: noise };

  const r = lineSplit_(m);
  const cache = CacheService.getScriptCache();
  const ck = 'line:' + lineSha256Hex_(lineDedupKey_(r)).slice(0, 40);
  if (cache.get(ck)) return { ok: true, skipped: '重複' };

  const sh = lineSheet_();
  // appendRow はシート側で1行ずつ足すので、同時に2件来ても行が重ならない（ロック不要）
  sh.appendRow(lineRow_(r, nowJst_()));
  cache.put(ck, '1', LINE_DEDUP_SEC_);
  return { ok: true, added: 1 };
}

function lineSheet_() {
  const sh = ensureLedgerSheet_(LINE_SHEET_, LINE_HEADER_, null);
  if (!sh.getRange(1, 1).getNote()) {
    LINE_WIDTHS_.forEach((w, i) => sh.setColumnWidth(i + 1, w));
    sh.getRange(1, 1).setNote('LineIntake.gs が MacroDroid（社長のスマホのLINE通知）から自動で足す。' +
      '処理状態：未処理／対応中／済／対象外。お客様の連絡は DM台帳 へ。');
  }
  return sh;
}

// ------------------------------------------------------------
//  書き込みAPI（WriteApi.gs から。合言葉 token の確認は doPost 側で済んでいる）
// ------------------------------------------------------------

function lineSetup_(body) {
  const key = String((body && body.key) || '');
  if (key.length < 24) throw new Error('key は24文字以上で');
  PropertiesService.getScriptProperties().setProperty(LINE_PROP_KEY_, lineSha256Hex_(key));
  const sh = lineSheet_();
  return { ok: true, sheet: LINE_SHEET_, keySet: true, rows: Math.max(0, sh.getLastRow() - 1) };
}

function lineOff_() {
  PropertiesService.getScriptProperties().deleteProperty(LINE_PROP_KEY_);
  return { ok: true, keySet: false };
}

function lineReadAll_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_SHEET_);
  if (!sh || sh.getLastRow() < 2) return [];
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, LINE_HEADER_.length).getDisplayValues();
  return vals.map((v, i) => ({
    row: i + 2, received: v[0], sender: v[1], talk: v[2], body: v[3], status: v[4], memo: v[5],
  })).filter(r => r.received || r.body);
}

function lineStatus_() {
  const keySet = !!PropertiesService.getScriptProperties().getProperty(LINE_PROP_KEY_);
  const all = lineReadAll_();
  const open = all.filter(r => !r.status || r.status === '未処理');
  return {
    ok: true, keySet: keySet, sheet: LINE_SHEET_, rows: all.length, unprocessed: open.length,
    last: all.length ? all[all.length - 1].received : '',
  };
}

/** {status?: '未処理'|'対応中'|'済'|'対象外'|'all', since?: 'yyyy-MM-dd', limit?: 100} */
function lineList_(q) {
  q = q || {};
  const status = String(q.status || '未処理');
  const since = String(q.since || '');
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  let rows = lineReadAll_();
  if (status !== 'all') rows = rows.filter(r => (r.status || '未処理') === status);
  if (since) rows = rows.filter(r => String(r.received) >= since);
  rows = rows.slice(-limit).reverse();
  return { ok: true, sheet: LINE_SHEET_, count: rows.length, rows: rows };
}

/** {row, status, memo?} E列を変え、memo があれば F列に「MM/dd HH:mm 内容」を追記 */
function lineSetStatus_(body) {
  const row = Number(body && body.row);
  const status = String((body && body.status) || '');
  if (!(row >= 2)) throw new Error('row は2以上の行番号で');
  if (LINE_STATUSES_.indexOf(status) < 0) throw new Error('status は ' + LINE_STATUSES_.join('／') + ' のどれか');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LINE_SHEET_);
  if (!sh || row > sh.getLastRow()) throw new Error('その行はありません: ' + row);
  sh.getRange(row, 5).setValue(status);
  const memo = lineClean_(body.memo || '');
  if (memo) {
    const cell = sh.getRange(row, 6);
    const cur = String(cell.getDisplayValue() || '');
    const stamp = Utilities.formatDate(new Date(), CONFIG.TZ, 'MM/dd HH:mm');
    cell.setValue((cur ? cur + '\n' : '') + stamp + ' ' + memo);
  }
  return { ok: true, row: row, status: status };
}

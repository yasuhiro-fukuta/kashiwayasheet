/**
 * ============================================================
 *  PaymentLedger.gs - 入金台帳（電子決済の全件の写し） (v1.00)
 * ============================================================
 *  2026-11-14 追加（社長決定「あ プログラムで全件自動」）。
 *
 *  ★起きていたこと
 *    Square・Stripe の入金は、毎日の「入金チェック」（AI）が直近14日だけを見て
 *    DM台帳に書いていた。14日より前の分・FS Square が読めなかった間の分・
 *    宿のレジの分が台帳に無く、「台帳に無い＝未入金」の誤判断のもとになった。
 *
 *  ★やること
 *    シート「入金台帳」に、決済1件＝1行で全件を写す（AIの判断を通さない）。
 *    決済ID（決済元＋ID）で重複を防ぎ、既にある行は 状態・返金額・更新日時 だけ
 *    上書きする（人が書いた「メモ」列は触らない）。
 *    書き手は kashiwaya-lp の /api/payments/sync（Square の全件をプログラムで送る）。
 *
 *  書き込みAPI:
 *    payment.upsert  rows: [{provider, account, id, at, status, amount, refunded,
 *                            items, name, email, card, orderId, ref, receipt}]
 *    payment.find    {since?, until?, account?, name?, limit?}
 *  ★カード番号は入れない（ブランドと下4桁まで）。
 * ============================================================
 */

const PAY_SHEET_ = '入金台帳';
const PAY_HEADER_ = ['決済キー', '決済元', '口座', '決済ID', '日時', '状態', '金額', '返金額',
  '品名', '名前', 'メール', 'カード', '注文ID', '予約番号など', 'レシート', 'メモ', '記入日時', '更新日時'];
const PAY_COL_ = PAY_HEADER_.reduce((m, h, i) => { m[h] = i; return m; }, {});

function paySheet_() {
  return ensureLedgerSheet_(PAY_SHEET_, PAY_HEADER_,
    [220, 70, 90, 220, 140, 90, 80, 70, 300, 160, 180, 120, 200, 160, 70, 200, 120, 120]);
}

function writeApiPaymentUpsert_(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows が空です');
  if (rows.length > 500) throw new Error('rows は1回500行まで');
  const sh = paySheet_();
  const W = PAY_HEADER_.length;
  const last = lastDataRow_(sh, W);
  const vals = last >= 2 ? sh.getRange(2, 1, last - 1, W).getDisplayValues() : [];
  const idx = {};
  vals.forEach((r, i) => { if (r[0]) idx[r[0]] = i; });
  const now = nowJst_();
  const newRows = [];
  let added = 0, updated = 0, same = 0;

  rows.forEach((r, i) => {
    const provider = String(r.provider || '').trim().toLowerCase();
    const id = String(r.id || '').trim();
    if (!provider || !id) throw new Error(`rows[${i}] provider と id が必要です`);
    if (/\d{12,}/.test(String(r.card || ''))) throw new Error(`rows[${i}].card にカード番号は入れない`);
    const key = `${provider}:${id}`;
    const status = String(r.status || '');
    const amount = String(Number(r.amount) || 0);
    const refunded = String(Number(r.refunded) || 0);

    if (idx[key] !== undefined && idx[key] >= 0) {
      const rowNo = idx[key] + 2;
      const cur = vals[idx[key]];
      if (cur[PAY_COL_['状態']] === status && String(cur[PAY_COL_['返金額']]) === refunded &&
          String(cur[PAY_COL_['金額']]) === amount) { same++; return; }
      sh.getRange(rowNo, PAY_COL_['状態'] + 1, 1, 3).setValues([[status, amount, refunded]]);
      sh.getRange(rowNo, PAY_COL_['更新日時'] + 1).setValue(now);
      updated++;
      return;
    }
    if (idx[key] === -1) return;   // 同じ呼び出しの中の重複
    const row = new Array(W).fill('');
    row[PAY_COL_['決済キー']] = key;
    row[PAY_COL_['決済元']] = provider;
    row[PAY_COL_['口座']] = String(r.account || '');
    row[PAY_COL_['決済ID']] = id;
    row[PAY_COL_['日時']] = String(r.at || '');
    row[PAY_COL_['状態']] = status;
    row[PAY_COL_['金額']] = amount;
    row[PAY_COL_['返金額']] = refunded;
    row[PAY_COL_['品名']] = String(r.items || '').slice(0, 2000);
    row[PAY_COL_['名前']] = String(r.name || '');
    row[PAY_COL_['メール']] = String(r.email || '');
    row[PAY_COL_['カード']] = String(r.card || '');
    row[PAY_COL_['注文ID']] = String(r.orderId || '');
    row[PAY_COL_['予約番号など']] = String(r.ref || '');
    row[PAY_COL_['レシート']] = String(r.receipt || '');
    row[PAY_COL_['記入日時']] = now;
    row[PAY_COL_['更新日時']] = now;
    newRows.push(textify_(row));
    idx[key] = -1;
    added++;
  });

  if (newRows.length) {
    const start = lastDataRow_(sh, W) + 1;
    sh.getRange(start, 1, newRows.length, W).setValues(newRows);
  }
  return { ok: true, sheet: PAY_SHEET_, added: added, updated: updated, unchanged: same };
}

function writeApiPaymentFind_(body) {
  const sh = paySheet_();
  const W = PAY_HEADER_.length;
  const last = lastDataRow_(sh, W);
  const vals = last >= 2 ? sh.getRange(2, 1, last - 1, W).getDisplayValues() : [];
  const since = String(body.since || ''), until = String(body.until || '');
  const account = String(body.account || '').trim();
  const name = String(body.name || '').trim().toLowerCase();
  const limit = Math.min(Number(body.limit) || 500, 5000);
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < limit; i--) {
    const r = vals[i];
    const day = String(r[PAY_COL_['日時']]).slice(0, 10);
    if (since && day < since) continue;
    if (until && day > until) continue;
    if (account && r[PAY_COL_['口座']] !== account) continue;
    if (name && String(r[PAY_COL_['名前']]).toLowerCase().indexOf(name) < 0) continue;
    const o = { row: i + 2 };
    PAY_HEADER_.forEach((h, c) => { o[h] = r[c]; });
    out.push(o);
  }
  return { ok: true, total: vals.length, rows: out };
}

/**
 * ============================================================
 *  Utils.gs - 共通ユーティリティ (v2.10)
 * ============================================================
 *  v2.10:
 *   ・toHalfWidth() を追加。
 *     フォーム回答に全角数字が混ざることがあり
 *     ("Chicken Hot Pot(１人前)" が実データに存在した)、
 *     /\d/ ベースの人数抽出が静かに 0 を返していた。
 *     人数を読む処理はすべてこれを通してから解析する。
 *
 *  v2.8:
 *   ・isoWeekday() / weekdayJa() を追加。
 *     泉屋送迎 (水・木のみ) の曜日チェックに使う。
 *     スクリプトのタイムゾーン設定に依存しないよう、
 *     CONFIG.TZ で yyyy-MM-dd に落としてから UTC 基準で曜日を求める。
 *     戻り値は M列の =WEEKDAY(D2,2) と同じ ISO 表記 (1=月 … 7=日)。
 *
 *  v2.6:
 *   ・nowJst() でミリ秒を切り捨て。
 *   ・sameTs() を追加。許容差(既定1秒)付きで日時を比較する。
 * ============================================================
 */

function todayJst() {
  const now = new Date();
  const ymd = Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd');
  return new Date(ymd + 'T00:00:00+09:00');
}

/**
 * バッチ基準時刻。ミリ秒は切り捨てる (シート往復での精度落ち対策)。
 */
function nowJst() {
  const d = new Date();
  d.setMilliseconds(0);
  return d;
}

/**
 * 日時の同一判定 (許容差付き)。
 * シートに書き込んだ Date は読み戻し時に数ミリ秒ずれることがあるため、
 * getTime() の完全一致ではなくこの関数で比較する。
 * @param {Date} a
 * @param {Date|number} b  Date または epoch ミリ秒
 * @param {number} [toleranceMs=1000]
 */
function sameTs(a, b, toleranceMs) {
  const tol = (toleranceMs == null) ? 1000 : toleranceMs;
  if (!(a instanceof Date)) return false;
  const bMs = (b instanceof Date) ? b.getTime() : Number(b);
  if (isNaN(bMs)) return false;
  return Math.abs(a.getTime() - bMs) <= tol;
}

/**
 * 全角英数記号を半角に変換する。
 *
 * Google フォームの自由入力・選択肢には全角数字が普通に混ざる。
 * 実データに "Chicken Hot Pot(１人前)" があり、/(\d+)人前/ が
 * マッチせず人数が 0 扱いになっていた。
 * 人数を数える処理は必ずこれを通してから正規表現をかけること。
 *
 * @param {*} v
 * @return {string}
 */
function toHalfWidth(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

/**
 * ISO曜日を返す。1=月, 2=火, 3=水, 4=木, 5=金, 6=土, 7=日。
 * 判定不能なら 0。
 *
 * M列の =WEEKDAY(D2,2) と同じ番号体系になるようにしてある。
 * getDay() はスクリプトのタイムゾーン設定に引きずられるため、
 * いったん CONFIG.TZ で日付文字列にしてから UTC で組み直している。
 *
 * @param {Date|string} v
 * @return {number} 1..7 (不明な場合は 0)
 */
function isoWeekday(v) {
  const dt = toDate(v);
  if (!dt || isNaN(dt.getTime())) return 0;
  const parts = Utilities.formatDate(dt, CONFIG.TZ, 'yyyy-MM-dd').split('-').map(Number);
  const utcMs = Date.UTC(parts[0], parts[1] - 1, parts[2]);
  const dow = new Date(utcMs).getUTCDay();   // 0=日, 1=月 ... 6=土
  return (dow === 0) ? 7 : dow;              // 1=月 ... 7=日
}

/**
 * ISO曜日 (1..7) を日本語1文字に変換する。範囲外は空文字。
 * @param {number} wd
 * @return {string}
 */
function weekdayJa(wd) {
  const names = ['月', '火', '水', '木', '金', '土', '日'];
  const n = Number(wd);
  if (!n || n < 1 || n > 7) return '';
  return names[n - 1];
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) {
    return new Date(
      Number(s.substr(0, 4)),
      Number(s.substr(4, 2)) - 1,
      Number(s.substr(6, 2))
    );
  }
  if (/^\d{8}T\d{6}/.test(s)) {
    return new Date(
      Number(s.substr(0, 4)),
      Number(s.substr(4, 2)) - 1,
      Number(s.substr(6, 2)),
      Number(s.substr(9, 2)),
      Number(s.substr(11, 2)),
      Number(s.substr(13, 2))
    );
  }
  return new Date(s);
}

function fmtDate(d) {
  if (!d) return '';
  const dt = toDate(d);
  if (!dt || isNaN(dt.getTime())) return '';
  return Utilities.formatDate(dt, CONFIG.TZ, 'yyyy-MM-dd');
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = toDate(d);
  if (!dt || isNaN(dt.getTime())) return '';
  return Utilities.formatDate(dt, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
}

function daysUntil(checkinDate) {
  const ci = toDate(checkinDate);
  const today = todayJst();
  const ms = ci.getTime() - today.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function isFourOrMoreDaysAhead(checkinDate) {
  return daysUntil(checkinDate) >= CONFIG.DAYS_THRESHOLD;
}

function dlog(...args) {
  if (CONFIG.DEBUG) {
    Logger.log(args.map(a =>
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' '));
  }
}

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Sheet not found: ${name}`);
  return sh;
}

/**
 * シートを truncate (ヘッダー1行を残して全データ削除)
 * deleteRows ではなく clearContent を使うことで
 * 「固定されていない行をすべて削除することはできません」エラーを回避
 */
function truncateSheet(sh) {
  const last = sh.getLastRow();
  if (last <= 1) return;
  const lastCol = Math.max(sh.getLastColumn(), 1);
  sh.getRange(2, 1, last - 1, lastCol).clearContent();
}

function readSheetData(sh, expectedCols) {
  const last = sh.getLastRow();
  if (last <= 1) return [];
  const values = sh.getRange(2, 1, last - 1, expectedCols).getValues();
  return values.filter(row => row.some(v => v !== '' && v !== null));
}

function getLastProcessedAt() {
  const v = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP.LAST_PROCESSED);
  if (!v) return new Date(0);
  return new Date(v);
}

function setLastProcessedAt(d) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.PROP.LAST_PROCESSED,
    d.toISOString()
  );
}

/**
 * 'yyyy-MM-dd' 文字列に日数を加算して 'yyyy-MM-dd' を返す。
 * UTC 基準で計算するので、スクリプトのタイムゾーン設定や
 * サマータイムの影響を受けない。
 */
function addDaysStr(ds, n) {
  const p = String(ds).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function numOrZero(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(toHalfWidth(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

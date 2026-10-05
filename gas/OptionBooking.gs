/**
 * ============================================================
 *  OptionBooking.gs — オプション予約 → Google カレンダー  v2.24
 * ============================================================
 *  E-bikeレンタル / ギアレンタル / 荷物運び / ツアーガイド など、
 *  外部業者へ手配する予約を Google カレンダーに流す。
 *
 *  流れ:
 *    別スレ「自動返信」で確定
 *      → 「オプション予約」シートに1行入る (人 or 別スレが書く)
 *      → 毎時バッチがカレンダーに予定を作る
 *
 *  ★このスクリプトが書き込むのは K列(登録日時) と L列(イベントID) だけ。
 *    A〜J列は人(または別スレ)の領域で、一切書き換えない。
 *
 *  ★J列「状態」が起点。
 *      確定 … 登録する。既に登録済みなら内容を更新する
 *      取消 … 登録済みの予定を削除する
 *      空欄 … 何もしない (下書き)
 *
 *  ★カレンダー権限が無い / IDが未設定でもバッチは止めない。
 *    理由をログに出して先に進む。
 * ============================================================
 */

/** メニュー・バッチから呼ぶ。失敗してもバッチを止めない。 */
function runOptionBookingSyncOnly() {
  const r = syncOptionBookings(nowJst());
  Logger.log(formatOptionBookingResult_(r));
  return r;
}

/**
 * オプション予約シートを読み、カレンダーに反映する。
 * @return {{ok, skipped, reason, created, updated, deleted, errors}}
 */
function syncOptionBookings(now) {
  const B = CONFIG.OPTION_BOOKING;
  const base = { ok: false, skipped: true, created: 0, updated: 0, deleted: 0, errors: [] };

  if (!B.ENABLED) return Object.assign({}, base, { reason: 'CONFIG.OPTION_BOOKING.ENABLED が false' });

  const sh = SpreadsheetApp.getActive().getSheetByName(B.SHEET);
  if (!sh) return Object.assign({}, base, { reason: `「${B.SHEET}」シートがありません (ensureOptionBookingSheet() で作れます)` });

  const last = sh.getLastRow();
  if (last < 2) return Object.assign({}, base, { ok: true, skipped: false, reason: '' });

  const calId = PropertiesService.getScriptProperties().getProperty(B.PROP_CALENDAR_ID);
  if (!calId) {
    return Object.assign({}, base, {
      reason: "カレンダーIDが未設定。setOptionCalendarId('…') を1回実行してください",
    });
  }

  let cal;
  try {
    cal = (calId === 'primary')
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(calId);
  } catch (e) {
    //  権限未承認はここに来る。承認を促すが、バッチは止めない。
    return Object.assign({}, base, {
      reason: 'カレンダーを開けません。初回はカレンダー権限の承認が要ります'
        + ` (メニューから「📅 オプション予約をカレンダーに反映」を手動で1回実行) / ${e.message || e}`,
    });
  }
  if (!cal) {
    return Object.assign({}, base, { reason: `カレンダーが見つかりません (ID=${calId})` });
  }

  const C = CONFIG.COL_OPTBK;
  const rows = sh.getRange(2, 1, last - 1, CONFIG.OPTBK_WIDTH).getDisplayValues();

  let created = 0, updated = 0, deleted = 0;
  const errors = [];
  const writes = [];   // [行番号, 登録日時, イベントID]

  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const status = String(r[C.STATUS - 1] || '').trim();
    const eventId = String(r[C.EVENT_ID - 1] || '').trim();

    try {
      if (status === B.STATUS_CANCEL) {
        if (!eventId) return;
        const ev = cal.getEventSeriesById(eventId);
        if (ev) { ev.deleteEventSeries(); deleted++; }
        writes.push([rowNo, '', '']);
        return;
      }
      if (status !== B.STATUS_FIXED) return;
      if (created + updated >= B.MAX_PER_RUN) return;

      const spec = buildOptionEventSpec(r);
      if (spec.error) { errors.push(`${rowNo}行目: ${spec.error}`); return; }

      if (eventId) {
        const ev = cal.getEventSeriesById(eventId);
        if (ev) {
          ev.setTitle(spec.title);
          ev.setDescription(spec.description);
          if (spec.allDay) ev.setAllDayDates(spec.start, spec.endExclusive);
          else             ev.setTime(spec.start, spec.end);
          updated++;
          writes.push([rowNo, fmtDateTime(now || nowJst()), eventId]);
          return;
        }
        //  IDはあるが予定が消えている → 作り直す
      }

      const ev = spec.allDay
        ? cal.createAllDayEvent(spec.title, spec.start, spec.endExclusive,
            { description: spec.description })
        : cal.createEvent(spec.title, spec.start, spec.end,
            { description: spec.description });
      if (B.COLOR) { try { ev.setColor(CalendarApp.EventColor[B.COLOR]); } catch (e) { /* 色は任意 */ } }
      created++;
      writes.push([rowNo, fmtDateTime(now || nowJst()), ev.getId()]);

    } catch (e) {
      errors.push(`${rowNo}行目: ${e.message || e}`);
    }
  });

  //  ★書き戻すのは K列(登録日時) と L列(イベントID) だけ。
  writes.forEach(w => {
    sh.getRange(w[0], C.SYNCED_AT, 1, 2).setValues([[w[1], w[2]]]);
  });

  return { ok: true, skipped: false, reason: '', created: created, updated: updated,
           deleted: deleted, errors: errors };
}

// ── 1行 → 予定の中身 (シートに触らないのでテストできる) ──────────

/**
 * シートの1行から、作る予定の中身を決める。
 * @return {{title, description, start, end, endExclusive, allDay, error}}
 */
function buildOptionEventSpec(row) {
  const B = CONFIG.OPTION_BOOKING;
  const C = CONFIG.COL_OPTBK;
  const g = n => String(row[n - 1] == null ? '' : row[n - 1]).trim();

  const dateStr = normalizeOptionDate_(g(C.DATE));
  if (!dateStr) return { error: `実施日が読めません (${g(C.DATE) || '空欄'})` };

  const kindRaw = g(C.KIND);
  if (!kindRaw) return { error: '区分が空欄です' };
  const kind = resolveOptionKind_(kindRaw);

  const name = g(C.GUEST_NAME);
  const room = g(C.ROOM);
  const qty  = g(C.QTY);
  const vendor = g(C.VENDOR);
  const memo = g(C.MEMO);

  //  時刻は 行の指定 → 区分の既定 の順。どちらも無ければ終日。
  const startT = normalizeOptionTime_(g(C.START)) || (kind ? kind.start : null);
  const endT   = normalizeOptionTime_(g(C.END))   || (kind ? kind.end   : null);

  const title = (B.TITLE || '{区分}{数量} {名前}{部屋}')
    .replace('{区分}', kind ? kind.label : kindRaw)
    .replace('{数量}', qty ? ` x${qty}` : '')
    .replace('{名前}', name || '(氏名なし)')
    .replace('{部屋}', room ? ` (${room})` : '')
    .replace('{業者}', vendor)
    .trim();

  const desc = [
    name   ? `宿泊者: ${name}` : '',
    room   ? `部屋: ${room}`   : '',
    qty    ? `数量: ${qty}`    : '',
    vendor ? `業者: ${vendor}` : '',
    memo   ? `メモ: ${memo}`   : '',
    '',
    '※柏屋のスプレッドシート「オプション予約」から自動登録',
  ].filter(x => x !== null).join('\n');

  if (!startT || !endT) {
    const d = parseOptionDate_(dateStr);
    return {
      title: title, description: desc, allDay: true,
      start: d, endExclusive: new Date(d.getTime() + 86400000), error: '',
    };
  }

  const start = parseOptionDateTime_(dateStr, startT);
  let end = parseOptionDateTime_(dateStr, endT);
  //  終了が開始より前なら翌日とみなす (17:00〜09:00 のような書き方)
  if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86400000);

  return { title: title, description: desc, allDay: false,
           start: start, end: end, endExclusive: null, error: '' };
}

/** 区分の文字から定義を引く。 */
function resolveOptionKind_(v) {
  const s = toHalfWidth(String(v || '')).trim();
  const list = CONFIG.OPTION_BOOKING.KINDS;
  for (let i = 0; i < list.length; i++) {
    if (list[i].test.test(s)) return list[i];
  }
  return null;
}

/** 'yyyy-MM-dd' にそろえる。'2026/10/20' '10/20' などでも読む。 */
function normalizeOptionDate_(v) {
  const s = toHalfWidth(String(v || '')).trim().replace(/[.年月]/g, '-').replace(/日/g, '');
  if (!s) return '';
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return `${m[1]}-${('0' + m[2]).slice(-2)}-${('0' + m[3]).slice(-2)}`;
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})$/);
  if (m) {
    const y = todayJst().getFullYear();
    return `${y}-${('0' + m[1]).slice(-2)}-${('0' + m[2]).slice(-2)}`;
  }
  const d = toDate(v);
  return d ? fmtDate(d) : '';
}

/** 'HH:mm' にそろえる。'9:00' '9時' '0900' でも読む。空なら ''。 */
function normalizeOptionTime_(v) {
  const s = toHalfWidth(String(v || '')).trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2] || 0);
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
      return `${('0' + h).slice(-2)}:${('0' + mi).slice(-2)}`;
    }
    return '';
  }
  m = s.match(/^(\d{2})(\d{2})$/);
  if (m) {
    const h = Number(m[1]), mi = Number(m[2]);
    if (h <= 23 && mi <= 59) return `${m[1]}:${m[2]}`;
  }
  return '';
}

function parseOptionDate_(ds) {
  const p = ds.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function parseOptionDateTime_(ds, ts) {
  const p = ds.split('-'), t = ts.split(':');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(t[0]), Number(t[1]));
}

// ── シートの用意 ────────────────────────────────────────────

/** 「オプション予約」シートを作る (既にあれば何もしない)。 */
function ensureOptionBookingSheet() {
  const B = CONFIG.OPTION_BOOKING;
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(B.SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(B.SHEET);
  const header = ['実施日', '区分', '宿泊者名', '部屋', '開始', '終了', '数量',
                  '業者', 'メモ', '状態', '登録日時(GAS)', 'イベントID(GAS)'];
  sh.getRange(1, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#e8eaed');
  //  GASが書き戻す2列は色を変えて、人が触らないようにする
  sh.getRange(1, CONFIG.COL_OPTBK.SYNCED_AT, 1, 2).setBackground('#d9d9d9');
  sh.setFrozenRows(1);
  sh.getRange(2, CONFIG.COL_OPTBK.DATE, sh.getMaxRows() - 1, 1).setNumberFormat('@');

  //  状態のドロップダウン
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([B.STATUS_FIXED, B.STATUS_CANCEL], true).build();
  sh.getRange(2, CONFIG.COL_OPTBK.STATUS, sh.getMaxRows() - 1, 1).setDataValidation(rule);

  Logger.log(`「${B.SHEET}」シートを作りました。`);
  return sh;
}

// ── ログ ────────────────────────────────────────────────────

function formatOptionBookingResult_(r) {
  if (!r.ok) return `オプション予約の反映をスキップ: ${r.reason}`;
  let s = `オプション予約: 登録${r.created} / 更新${r.updated} / 削除${r.deleted}`;
  if (r.errors && r.errors.length) {
    s += `\n  ⚠ 取り込めなかった行:\n   ・` + r.errors.join('\n   ・');
  }
  return s;
}

/** 書き込みなしで、何が登録されるかだけ確認する。 */
function dumpOptionBookings() {
  const B = CONFIG.OPTION_BOOKING;
  const sh = SpreadsheetApp.getActive().getSheetByName(B.SHEET);
  const L = [];
  L.push('════════ オプション予約の確認 (書き込みなし) ════════');

  const calId = PropertiesService.getScriptProperties().getProperty(B.PROP_CALENDAR_ID);
  L.push(`カレンダーID: ${calId || '★未設定 — setOptionCalendarId(\'…\') を実行してください'}`);

  if (!sh) {
    L.push(`★「${B.SHEET}」シートがありません。ensureOptionBookingSheet() で作れます。`);
    Logger.log(L.join('\n'));
    return [];
  }
  const last = sh.getLastRow();
  if (last < 2) {
    L.push('行がありません。');
    Logger.log(L.join('\n'));
    return [];
  }

  const C = CONFIG.COL_OPTBK;
  const rows = sh.getRange(2, 1, last - 1, CONFIG.OPTBK_WIDTH).getDisplayValues();
  const out = [];
  rows.forEach((r, i) => {
    const status = String(r[C.STATUS - 1] || '').trim();
    const spec = buildOptionEventSpec(r);
    const mark = status === B.STATUS_FIXED ? '登録'
      : (status === B.STATUS_CANCEL ? '取消' : '—(下書き)');
    L.push(`${i + 2}行目 [${mark}] ${spec.error ? '★' + spec.error : spec.title}`);
    if (!spec.error && status === B.STATUS_FIXED) {
      L.push(`        ${spec.allDay ? '終日 ' + fmtDate(spec.start)
        : fmtDateTime(spec.start) + ' 〜 ' + fmtDateTime(spec.end)}`);
    }
    out.push(spec);
  });
  Logger.log(L.join('\n'));
  return out;
}

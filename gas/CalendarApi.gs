/**
 * ============================================================
 *  CalendarApi.gs - 書き込み API からカレンダーを読む・消す  v1.00
 * ============================================================
 *  2026-10-26 社長決定：Claude の Google カレンダー接続は
 *  利用上限（Resource has been exhausted）に当たることがあるので、
 *  定時チェックのカレンダー確認・削除は GAS 経由でもできるようにする。
 *
 *  action（WriteApi.gs の doPost から呼ぶ）:
 *   cal.list   … 予定を読む
 *                {calendarId?, from:'yyyy-MM-dd', to:'yyyy-MM-dd', q?, max?}
 *                to はその日を含む。calendarId を省くと
 *                オプション予約と同じカレンダー（柏屋）。
 *                返り値 events: [{id, title, start, end, allDay,
 *                                 recurring, description}]
 *   cal.delete … 予定を1件消す  {calendarId?, eventId}
 *                ★繰り返し予定（定例）は消さない（系列ごと消えるため）。
 *                ★オプション予約シートの L列（イベントID）にある予定も
 *                  消さない（シートの J列を「取消」にすれば GAS が消す）。
 *   option.sync … オプション予約 → カレンダーだけを今すぐ回し、
 *                 登録・更新・削除の件数とエラーを返す
 *
 *  使う権限は既存の CalendarApp と同じ（新しい承認は要らない）。
 * ============================================================
 */

/** calendarId 省略時はオプション予約と同じカレンダーを開く。 */
function calApiOpen_(calendarId) {
  const B = CONFIG.OPTION_BOOKING;
  let id = String(calendarId || '').trim();
  if (!id) {
    id = PropertiesService.getScriptProperties().getProperty(B.PROP_CALENDAR_ID)
      || B.DEFAULT_CALENDAR_ID || 'primary';
  }
  const cal = (id === 'primary') ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  if (!cal) throw new Error(`カレンダーが見つかりません: ${id}`);
  return cal;
}

/** yyyy-MM-dd → その日の 0:00（JST）。 */
function calApiDay_(s, label) {
  const v = requireDate_(s, label);
  return new Date(`${v}T00:00:00+09:00`);
}

function calApiFmt_(d) {
  return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd HH:mm');
}

/**
 * 予定IDから予定を取り出す。Calendar API の id（末尾 @google.com なし）でも、
 * CalendarApp の iCalUID（末尾 @google.com あり）でも探せるようにする。
 */
function calApiFind_(cal, eventId) {
  const raw = String(eventId || '').trim();
  if (!raw) throw new Error('eventId が空です');
  const ids = [raw];
  if (raw.indexOf('@') < 0) ids.push(`${raw}@google.com`);
  for (let i = 0; i < ids.length; i++) {
    try {
      const ev = cal.getEventById(ids[i]);
      if (ev) return ev;
    } catch (e) { /* 次の形で探す */ }
  }
  return null;
}

function writeApiCalList_(body) {
  const cal = calApiOpen_(body.calendarId);
  const from = calApiDay_(body.from, 'from');
  const toDay = calApiDay_(body.to || body.from, 'to');
  const to = new Date(toDay.getTime() + 24 * 60 * 60 * 1000);
  if (to <= from) throw new Error('to は from 以降の日付で');
  if (to - from > 62 * 24 * 60 * 60 * 1000) throw new Error('期間は62日まで');
  const max = Math.min(Math.max(Number(body.max) || 200, 1), 500);
  const q = String(body.q || '').trim();
  const list = q ? cal.getEvents(from, to, { search: q }) : cal.getEvents(from, to);
  const events = list.slice(0, max).map(ev => {
    const allDay = ev.isAllDayEvent();
    const desc = String(ev.getDescription() || '');
    return {
      id: ev.getId(),
      title: ev.getTitle(),
      start: allDay ? Utilities.formatDate(ev.getAllDayStartDate(), CONFIG.TZ, 'yyyy-MM-dd') : calApiFmt_(ev.getStartTime()),
      end: allDay ? Utilities.formatDate(ev.getAllDayEndDate(), CONFIG.TZ, 'yyyy-MM-dd') : calApiFmt_(ev.getEndTime()),
      allDay: allDay,
      recurring: ev.isRecurringEvent(),
      description: desc.length > 500 ? desc.slice(0, 500) + '…' : desc,
    };
  });
  return { ok: true, calendar: cal.getName(), total: list.length, events: events };
}

/** オプション予約シートの L列（イベントID）に載っている ID の一覧。 */
function calApiOptionEventIds_() {
  const B = CONFIG.OPTION_BOOKING;
  const C = CONFIG.COL_OPTBK;
  const sh = SpreadsheetApp.getActive().getSheetByName(B.SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, C.EVENT_ID, sh.getLastRow() - 1, 1).getDisplayValues()
    .map(r => String(r[0] || '').trim()).filter(Boolean);
}

function writeApiCalDelete_(body) {
  const cal = calApiOpen_(body.calendarId);
  const ev = calApiFind_(cal, body.eventId);
  if (!ev) return { ok: false, error: `予定が見つかりません: ${body.eventId}` };
  if (ev.isRecurringEvent()) {
    return { ok: false, error: '繰り返し予定は消しません（系列ごと消えるため）。カレンダーで手で消してください' };
  }
  const id = ev.getId();
  const bare = id.replace(/@google\.com$/, '');
  const linked = calApiOptionEventIds_().some(x => x === id || x.replace(/@google\.com$/, '') === bare);
  if (linked) {
    return { ok: false, error: 'オプション予約シートが管理している予定です。J列を「取消」にしてください' };
  }
  const info = {
    id: id,
    title: ev.getTitle(),
    start: ev.isAllDayEvent()
      ? Utilities.formatDate(ev.getAllDayStartDate(), CONFIG.TZ, 'yyyy-MM-dd')
      : calApiFmt_(ev.getStartTime()),
  };
  ev.deleteEvent();
  return { ok: true, deleted: info, calendar: cal.getName() };
}

function writeApiOptionSync_() {
  const r = syncOptionBookings(nowJst());
  return Object.assign({ ok: !!r.ok }, r, { summary: formatOptionBookingResult_(r) });
}

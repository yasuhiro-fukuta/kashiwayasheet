/**
 * ============================================================
 *  IraiWatch.gs - 依頼箱の即時起動  v1.00 (2026-11-21)
 * ============================================================
 *  音声のClaudeが依頼箱シート「依頼」に「未着手」の行を書いたら、
 *  数分以内に実行役のスケジュールタスク (Claude Code のルーティン) を
 *  API トリガー (/fire) で起こす。これまでは実行役が 5:50・17:50 の
 *  定時にしか動かず、最大12時間待っていた (社長決定 2026-11-21「い」)。
 *
 *  動き (iraiWatch。5分ごとの時間トリガー):
 *   1. Script Properties に IRAI_FIRE_TOKEN が無ければ何もしない
 *   2. 依頼箱 (IRAI_SHEET_ID) の D列が「未着手」の行を集める。無ければ終わり
 *   3. 「実行中」の行があり、その受付 (A列) から30分以内なら撃たない (二重起動の防止)
 *   4. 未着手のうち、まだ撃っていない行 (IRAI_FIRED に無い 行番号＋受付) があれば
 *      /fire を1回だけ呼ぶ。本文は固定文＋行番号だけ (依頼の中身は送らない)
 *   5. 成功 → IRAI_FIRED に記録し、該当行の F列メモに「自動起動 HH:mm」を追記
 *      失敗 → 記録しない (次の回に再試行)
 *   6. 1日 (日本時間) に60回撃ったら、その日はもう撃たない (暴走止め)
 *      IRAI_FIRED は7日より古いものを捨てる
 *
 *  判断は純粋関数 (iraiPlan_ / iraiPruneFired_ / iraiFiresToday_ など) に分け、
 *  test/irai-watch.test.js で node から検証している。
 *
 *  設定・確認・停止は WriteApi.gs の irai.setup / irai.status / irai.off から。
 *  ★トークンの値はログにも返り値にも出さない。
 * ============================================================
 */

// ------------------------------------------------------------
//  純粋関数 (シートにもネットにも触らない。テスト対象)
// ------------------------------------------------------------

/**
 * A列(受付日時) の値をミリ秒にする。読めなければ null。
 *  Date ならそのまま。文字列は "yyyy-MM-dd HH:mm(:ss)" または "yyyy/MM/dd HH:mm" を
 *  日本時間として読む (日本に夏時間は無いので +09:00 固定でよい)。
 */
function iraiParseReceived_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const t = v.getTime();
    return isNaN(t) ? null : t;
  }
  const s = String(v).trim();
  const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (!m) return null;
  const pad = n => ('0' + n).slice(-2);
  const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}+09:00`;
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

/** 受付の値を、撃った記録の照合用の文字列にする (行が消えて番号がずれたときの取り違え防止) */
function iraiRecvKey_(v) {
  const t = iraiParseReceived_(v);
  return t === null ? String(v === null || v === undefined ? '' : v).trim() : String(t);
}

/** 日本時間の日付キー "yyyy-MM-dd" */
function iraiJstDayKey_(ms) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 撃った記録の形を整える。壊れていれば空にする。
 *  形: { fires: [ { at: ms, rows: [ {row: 3, recv: '…'} ], session: '…' } ] }
 */
function iraiNormalizeFired_(state) {
  const fires = state && Array.isArray(state.fires) ? state.fires : [];
  return {
    fires: fires
      .filter(f => f && typeof f.at === 'number' && Array.isArray(f.rows))
      .map(f => ({
        at: f.at,
        rows: f.rows.filter(r => r && typeof r.row === 'number').map(r => ({ row: r.row, recv: String(r.recv || '') })),
        session: String(f.session || ''),
      })),
  };
}

/** keepDays 日より古い記録を捨てる */
function iraiPruneFired_(state, nowMs, keepDays) {
  const s = iraiNormalizeFired_(state);
  const limit = nowMs - keepDays * 24 * 3600 * 1000;
  return { fires: s.fires.filter(f => f.at >= limit) };
}

/** 今日 (日本時間) 撃った回数 */
function iraiFiresToday_(state, nowMs) {
  const today = iraiJstDayKey_(nowMs);
  return iraiNormalizeFired_(state).fires.filter(f => iraiJstDayKey_(f.at) === today).length;
}

/**
 * 撃つかどうかを決める。
 * @param {Array<Array>} rows  依頼シートの2行目以降の値 (A〜F)。rows[0] がシートの2行目
 * @param {number} nowMs
 * @param {Object} fired  IRAI_FIRED を JSON.parse したもの
 * @param {Object} cfg    CONFIG.IRAI
 * @return {{action: 'none'|'skip-running'|'skip-cap'|'skip-already'|'fire',
 *           pending: number[], targets: Array<{row:number, recv:string}>,
 *           running: number[], firesToday: number}}
 */
function iraiPlan_(rows, nowMs, fired, cfg) {
  const C = cfg.COL;
  const pending = [];
  const pendingRecv = {};
  const running = [];
  (rows || []).forEach((r, i) => {
    const rowNo = i + 2;
    const st = String(r[C.STATUS - 1] === null || r[C.STATUS - 1] === undefined ? '' : r[C.STATUS - 1]).trim();
    if (st === cfg.STATUS_TODO) {
      pending.push(rowNo);
      pendingRecv[rowNo] = iraiRecvKey_(r[C.RECEIVED - 1]);
    } else if (st === cfg.STATUS_RUNNING) {
      const t = iraiParseReceived_(r[C.RECEIVED - 1]);
      //  受付が読めない「実行中」は止めない (残ったままだと永久に撃てなくなるため)
      if (t !== null && nowMs - t <= cfg.RUNNING_GUARD_MIN * 60 * 1000 && nowMs - t >= -5 * 60 * 1000) {
        running.push(rowNo);
      }
    }
  });

  const state = iraiNormalizeFired_(fired);
  const firesToday = iraiFiresToday_(state, nowMs);
  const base = { pending: pending, targets: [], running: running, firesToday: firesToday };
  if (!pending.length) return Object.assign(base, { action: 'none' });
  if (running.length) return Object.assign(base, { action: 'skip-running' });

  const done = {};
  state.fires.forEach(f => f.rows.forEach(x => { done[`${x.row}|${x.recv}`] = true; }));
  const targets = pending
    .filter(rowNo => !done[`${rowNo}|${pendingRecv[rowNo]}`])
    .map(rowNo => ({ row: rowNo, recv: pendingRecv[rowNo] }));
  base.targets = targets;
  if (!targets.length) return Object.assign(base, { action: 'skip-already' });
  if (firesToday >= cfg.DAILY_FIRE_CAP) return Object.assign(base, { action: 'skip-cap' });
  return Object.assign(base, { action: 'fire' });
}

/** /fire に送る固定文 (依頼の中身は入れない) */
function iraiFireText_(pendingRows) {
  return `依頼箱に未着手の依頼があります（行番号: ${pendingRows.join(', ')}）。指示文どおり依頼箱を処理してください。`;
}

/** F列メモに追記した後の文字列 (既存のメモは消さない) */
function iraiAppendMemo_(oldMemo, hhmm) {
  const add = `自動起動 ${hhmm}`;
  const old = String(oldMemo === null || oldMemo === undefined ? '' : oldMemo).trim();
  return old ? `${old} / ${add}` : add;
}

/** 撃った記録を足す */
function iraiRecordFire_(state, nowMs, targets, session) {
  const s = iraiNormalizeFired_(state);
  s.fires.push({ at: nowMs, rows: targets.map(t => ({ row: t.row, recv: t.recv })), session: String(session || '') });
  return s;
}

// ------------------------------------------------------------
//  GAS 側 (シート・ネット・トリガー)
// ------------------------------------------------------------

function iraiProps_() {
  return PropertiesService.getScriptProperties();
}

function iraiReadFired_() {
  try {
    return iraiNormalizeFired_(JSON.parse(iraiProps_().getProperty(CONFIG.IRAI.PROP_FIRED) || '{}'));
  } catch (e) {
    Logger.log(`iraiWatch: IRAI_FIRED が壊れていたので空として扱う: ${e}`);
    return { fires: [] };
  }
}

/** 5分ごとの時間トリガーから呼ばれる */
function iraiWatch() {
  const I = CONFIG.IRAI;
  const props = iraiProps_();
  const token = props.getProperty(I.PROP_TOKEN);
  if (!token) return { ok: true, action: 'no-token' };
  const sheetId = props.getProperty(I.PROP_SHEET_ID);
  if (!sheetId) {
    Logger.log('iraiWatch: IRAI_SHEET_ID が未設定 (irai.setup で sheetId を渡す)');
    return { ok: false, action: 'no-sheet-id' };
  }
  const triggerId = props.getProperty(I.PROP_TRIGGER_ID) || I.DEFAULT_TRIGGER_ID;

  //  毎時バッチ (ScriptLock) とは別の鍵にして、バッチ中でも待たせない
  const lock = LockService.getUserLock();
  if (!lock.tryLock(10 * 1000)) {
    Logger.log('iraiWatch SKIPPED: 前の iraiWatch が実行中');
    return { ok: true, action: 'locked' };
  }
  try {
    const sh = SpreadsheetApp.openById(sheetId).getSheetByName(I.SHEET_NAME);
    if (!sh) throw new Error(`依頼箱にシート「${I.SHEET_NAME}」がありません`);
    const last = sh.getLastRow();
    const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, I.COL.MEMO).getValues();

    const nowMs = Date.now();
    let fired = iraiPruneFired_(iraiReadFired_(), nowMs, I.KEEP_DAYS);
    const plan = iraiPlan_(rows, nowMs, fired, I);
    if (plan.action !== 'fire') {
      if (plan.action !== 'none') {
        Logger.log(`iraiWatch: ${plan.action} 未着手=${plan.pending.join(',')} 実行中=${plan.running.join(',')} 今日=${plan.firesToday}回`);
      }
      //  古い記録の掃除だけは保存する
      props.setProperty(I.PROP_FIRED, JSON.stringify(fired));
      return { ok: true, action: plan.action, pending: plan.pending };
    }

    const url = I.FIRE_URL.replace('{id}', encodeURIComponent(triggerId));
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': I.BETA,
        'anthropic-version': I.API_VERSION,
      },
      payload: JSON.stringify({ text: iraiFireText_(plan.pending) }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText() || '';
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 本文がJSONでないときはそのまま */ }

    if (code < 200 || code >= 300) {
      //  失敗は記録しない → 次の回に再試行
      Logger.log(`iraiWatch: /fire 失敗 HTTP ${code} 行=${plan.targets.map(t => t.row).join(',')} 本文=${text.slice(0, 500)}`);
      props.setProperty(I.PROP_FIRED, JSON.stringify(fired));
      return { ok: false, action: 'fire-failed', code: code };
    }

    const sessionUrl = (json && (json.claude_code_session_url || json.claude_code_session_id)) || '';
    Logger.log(`iraiWatch: /fire 成功 HTTP ${code} 行=${plan.targets.map(t => t.row).join(',')} session=${sessionUrl}`);
    fired = iraiRecordFire_(fired, nowMs, plan.targets, sessionUrl);
    props.setProperty(I.PROP_FIRED, JSON.stringify(fired));

    //  F列メモに追記 (撃った対象の行だけ。既存のメモは残す)
    const hhmm = Utilities.formatDate(new Date(nowMs), CONFIG.TZ, 'HH:mm');
    plan.targets.forEach(t => {
      const cell = sh.getRange(t.row, I.COL.MEMO);
      cell.setValue(iraiAppendMemo_(cell.getValue(), hhmm));
    });
    SpreadsheetApp.flush();
    return { ok: true, action: 'fired', rows: plan.targets.map(t => t.row), session: sessionUrl };
  } catch (e) {
    //  握りつぶさずログに残し、呼び出し元 (トリガー) にも失敗として返す
    Logger.log(`iraiWatch ERROR: ${e && e.stack || e}`);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** iraiWatch の時間トリガーがあれば返す */
function iraiFindTriggers_() {
  return ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'iraiWatch');
}

/**
 * irai.setup … トークン・実行役タスクID・依頼箱IDを保存し、トリガーが無ければ作る。
 *  ★返り値にトークンを含めない。
 */
function iraiSetup_(body) {
  const I = CONFIG.IRAI;
  const props = iraiProps_();
  const b = body || {};
  if (b.fireToken !== undefined && b.fireToken !== null && String(b.fireToken).trim() !== '') {
    props.setProperty(I.PROP_TOKEN, String(b.fireToken).trim());
  }
  if (b.triggerId !== undefined && b.triggerId !== null && String(b.triggerId).trim() !== '') {
    const id = String(b.triggerId).trim();
    if (!/^trig_[A-Za-z0-9]+$/.test(id)) throw new Error(`triggerId の形が違います: "${id}"`);
    props.setProperty(I.PROP_TRIGGER_ID, id);
  }
  if (b.sheetId !== undefined && b.sheetId !== null && String(b.sheetId).trim() !== '') {
    const sid = String(b.sheetId).trim();
    if (!/^[A-Za-z0-9_-]{20,}$/.test(sid)) throw new Error('sheetId はURLではなくID部分だけ (/d/ と /edit の間)');
    props.setProperty(I.PROP_SHEET_ID, sid);
  }
  if (!props.getProperty(I.PROP_SHEET_ID)) throw new Error('sheetId (依頼箱のスプレッドシートID) が未設定です。初回は sheetId を渡してください');

  //  依頼箱が開けるかをここで確かめる (権限・ID違いを設定時に分かるように)
  const sh = SpreadsheetApp.openById(props.getProperty(I.PROP_SHEET_ID)).getSheetByName(I.SHEET_NAME);
  if (!sh) throw new Error(`依頼箱にシート「${I.SHEET_NAME}」がありません`);

  let trigger = 'exists';
  if (!iraiFindTriggers_().length) {
    ScriptApp.newTrigger('iraiWatch').timeBased().everyMinutes(I.EVERY_MINUTES).create();
    trigger = 'created';
  }
  return Object.assign({ ok: true, trigger: trigger }, iraiStatusBody_());
}

/** irai.status … 状態を返す (トークンの値は返さない) */
function iraiStatus_() {
  return Object.assign({ ok: true }, iraiStatusBody_());
}

function iraiStatusBody_() {
  const I = CONFIG.IRAI;
  const props = iraiProps_();
  const fired = iraiReadFired_();
  const nowMs = Date.now();
  const fmt = ms => Utilities.formatDate(new Date(ms), CONFIG.TZ, 'yyyy-MM-dd HH:mm');
  return {
    triggerActive: iraiFindTriggers_().length > 0,
    triggerCount: iraiFindTriggers_().length,
    tokenSet: !!props.getProperty(I.PROP_TOKEN),
    sheetIdSet: !!props.getProperty(I.PROP_SHEET_ID),
    routineTriggerId: props.getProperty(I.PROP_TRIGGER_ID) || I.DEFAULT_TRIGGER_ID,
    firesToday: iraiFiresToday_(fired, nowMs),
    dailyCap: I.DAILY_FIRE_CAP,
    recentFires: fired.fires.slice(-10).reverse().map(f => ({
      at: fmt(f.at), rows: f.rows.map(r => r.row), session: f.session,
    })),
  };
}

/** irai.off … iraiWatch のトリガーを消す (戻し方)。トークン等の設定は残す */
function iraiOff_() {
  const ts = iraiFindTriggers_();
  ts.forEach(t => ScriptApp.deleteTrigger(t));
  return { ok: true, removed: ts.length };
}

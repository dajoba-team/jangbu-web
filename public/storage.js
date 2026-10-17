// ============================================================
// 장부결제 v20 - 서버 저장 어댑터 (Supabase)
// ------------------------------------------------------------
// index.html의 v19 IndexedDB 저장 함수(metaGet/metaSet/sigs*)를
// 같은 이름·같은 입출력으로 Supabase에 저장하도록 바꾼 파일.
// 앱(index.html)의 save()는 그대로 "전체 상태"를 넘기고,
// 여기서 직전 상태와 비교해 바뀐 행만 서버에 보낸다.
// ============================================================

// ===== 설정 (Supabase 대시보드 → Project Settings → API Keys) =====
const SUPABASE_URL = "https://mtnuwdcxjxpnrpggbfwc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mx_XoyLrOcMaHTuZqfN5vA_yL5Nb1eO";  // publishable key (공개돼도 되는 키. secret 키는 절대 넣지 말 것)

const SIG_BUCKET = "signatures";
const SIG_URL_TTL = 7 * 24 * 3600; // 서명 이미지 임시 URL 유효기간(초). 지나면 새로고침 필요
const PAGE = 1000;                 // Supabase API 1회 최대 조회 행 수
const CHUNK = 500;                 // 1회 쓰기 행 수
const MASS_DELETE_CONFIRM = 30;    // 한 번에 이 개수 이상 삭제되면 확인창

const _sb = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// ===== 앱 객체 ↔ DB 행 변환 =====
const _CO_KEYS = ["id", "name", "manager", "phone", "createdAt"];
const _TX_KEYS = ["id", "cid", "type", "amount", "desc", "date", "staff", "clientName", "ppl"];
const _SIG_KINDS = { sig: "sig_path", staffSig: "staff_sig_path", adminSig: "admin_sig_path" };

// 컬럼에 없는 앱 필드는 extra(jsonb)에 보관 → 데이터 유실 방지
const _extra = (o, keys) => {
  const e = {};
  for (const k in o) if (!keys.includes(k) && !(k in _SIG_KINDS) && o[k] !== undefined) e[k] = o[k];
  return e;
};
const _nn = v => (v === undefined ? null : v);

const _coToRow = c => ({
  id: c.id, name: c.name ?? "", manager: _nn(c.manager), phone: _nn(c.phone), reg_date: _nn(c.createdAt),
  extra: _extra(c, _CO_KEYS), deleted_at: null,
});
const _rowToCo = r => {
  const c = { ...(r.extra || {}), id: r.id, name: r.name };
  if (r.manager !== null) c.manager = r.manager;
  if (r.phone !== null) c.phone = r.phone;
  if (r.reg_date !== null) c.createdAt = r.reg_date;
  return c;
};
const _txToRow = t => ({
  id: t.id, company_id: t.cid, type: t.type, amount: t.amount, description: _nn(t.desc),
  occurred_at: t.date, staff: _nn(t.staff), client_name: _nn(t.clientName), ppl: _nn(t.ppl),
  extra: _extra(t, _TX_KEYS), deleted_at: null,
});
const _rowToTx = r => {
  const t = { ...(r.extra || {}), id: r.id, cid: r.company_id, type: r.type, amount: Number(r.amount), date: new Date(r.occurred_at).toISOString() };
  if (r.description !== null) t.desc = r.description;
  if (r.staff !== null) t.staff = r.staff;
  if (r.client_name !== null) t.clientName = r.client_name;
  if (r.ppl !== null) t.ppl = r.ppl;
  return t;
};

// ===== 상태 =====
// 서버에 저장된 것으로 확인된 마지막 상태 (id → 행 JSON). metaSet은 이것과 비교해 바뀐 행만 보낸다.
const _snap = { cos: new Map(), txs: new Map() };
let _loaded = false;
let _sigRows = [];        // 초기 로드 시 서명 경로가 있는 거래 행
let _lastWrite = null;    // 직전 metaSet에서 쓴 id (저장 검증용)

// ===== 화면 오버레이 (로그인 / 오류) =====
const _overlay = html => {
  let el = document.getElementById("st-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "st-overlay";
    el.style.cssText = "position:fixed;inset:0;z-index:10000;background:#f8fafc;display:flex;align-items:center;justify-content:center;padding:24px;font-family:'Noto Sans KR',-apple-system,sans-serif";
    document.body.appendChild(el);
  }
  el.innerHTML = '<div style="width:100%;max-width:360px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:28px 24px;box-shadow:0 4px 24px rgba(0,0,0,.06)">' + html + "</div>";
  return el;
};
const _closeOverlay = () => { const el = document.getElementById("st-overlay"); if (el) el.remove(); };
const _esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const _btnCss = "width:100%;padding:14px;border:none;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:15px;font-weight:700;cursor:pointer";
const _inpCss = "width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:10px;font-size:15px;margin-bottom:10px;outline:none";

let _loginP = null;
const _ensureLogin = () => {
  if (_loginP) return _loginP;
  _loginP = (async () => {
    if (!_sb) {
      _overlay('<div style="font-size:18px;font-weight:800;margin-bottom:8px">⚙️ 서버 설정 필요</div><div style="font-size:13px;color:#64748b;line-height:1.6">storage.js 맨 위의 SUPABASE_URL, SUPABASE_ANON_KEY를 입력해야 합니다.</div>');
      await new Promise(() => {}); // 설정 전에는 진행하지 않음
    }
    const { data } = await _sb.auth.getSession();
    if (data && data.session) return;
    await new Promise(resolve => {
      const el = _overlay(
        '<div style="font-size:20px;font-weight:800;margin-bottom:4px">📋 장부결제</div>' +
        '<div style="font-size:13px;color:#64748b;margin-bottom:20px">로그인이 필요합니다</div>' +
        '<form id="st-login"><input id="st-email" type="email" autocomplete="username" placeholder="이메일" style="' + _inpCss + '">' +
        '<input id="st-pw" type="password" autocomplete="current-password" placeholder="비밀번호" style="' + _inpCss + '">' +
        '<div id="st-msg" style="font-size:12px;color:#ef4444;min-height:18px;margin-bottom:6px"></div>' +
        '<button type="submit" style="' + _btnCss + '">로그인</button></form>'
      );
      el.querySelector("#st-login").onsubmit = async ev => {
        ev.preventDefault();
        const msg = el.querySelector("#st-msg");
        msg.textContent = "로그인 중...";
        const { error } = await _sb.auth.signInWithPassword({
          email: el.querySelector("#st-email").value.trim(),
          password: el.querySelector("#st-pw").value,
        });
        if (error) { msg.textContent = "로그인 실패: 이메일 또는 비밀번호를 확인하세요"; return; }
        _closeOverlay();
        resolve();
      };
    });
  })();
  return _loginP;
};

// 실패하면 빈 화면으로 넘어가지 않고 "다시 시도" 화면에서 멈춘다
// (빈 데이터로 앱이 시작되면 데이터가 사라진 것처럼 보이기 때문)
const _retryUntilOk = async fn => {
  for (;;) {
    try { const r = await fn(); _closeOverlay(); return r; }
    catch (e) {
      console.error("[storage] load failed:", e);
      await new Promise(resolve => {
        const el = _overlay(
          '<div style="font-size:18px;font-weight:800;margin-bottom:8px">⚠️ 서버 연결 실패</div>' +
          '<div style="font-size:13px;color:#64748b;line-height:1.6;margin-bottom:16px">인터넷 연결을 확인한 뒤 다시 시도하세요.<br><span style="color:#94a3b8">' + _esc((e && e.message) || e) + "</span></div>" +
          '<button id="st-retry" style="' + _btnCss + '">다시 시도</button>'
        );
        el.querySelector("#st-retry").onclick = resolve;
      });
      _overlay('<div style="text-align:center;font-size:14px;color:#64748b">불러오는 중...</div>');
      // 로그인 만료(JWT) 오류면 로그아웃 후 로그인 화면으로
      if (/jwt|401|unauthorized|refresh token/i.test(String((e && e.message) || e))) {
        await _sb.auth.signOut().catch(() => {});
        _loginP = null;
        await _ensureLogin();
      }
    }
  }
};

// ===== Supabase 헬퍼 =====
const _chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const _check = ({ data, error }) => { if (error) throw new Error(error.message || String(error)); return data; };

const _fetchAll = async (table, cols) => {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const rows = _check(await _sb.from(table).select(cols).is("deleted_at", null).order("id").range(from, from + PAGE - 1));
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
};

// ===== 전송 대기 목록 (localStorage) =====
// 저장 실패 후 앱을 닫아도 거래·서명이 사라지지 않도록, 서버 반영이 확인될 때까지 기기에 보관.
// 다음 실행 시 서버 데이터를 불러오기 전에 먼저 다시 보낸다.
const _PENDING_KEY = "jangbu_pending_v1";
const _pendLoad = () => {
  try {
    const p = JSON.parse(localStorage.getItem(_PENDING_KEY));
    if (p && p.rows && p.del && p.sigs) return p;
  } catch {}
  return { rows: { companies: {}, transactions: {} }, del: { companies: {}, transactions: {} }, sigs: {} };
};
const _pendSave = p => {
  try { localStorage.setItem(_PENDING_KEY, JSON.stringify(p)); }
  catch (e) { console.error("[storage] pending save failed:", e); }
};
const _pendEdit = fn => { const p = _pendLoad(); fn(p); _pendSave(p); };
const _pendCount = p => ["companies", "transactions"].reduce((n, t) => n + Object.keys(p.rows[t]).length + Object.keys(p.del[t]).length, 0) + Object.keys(p.sigs).length;

// 행 upsert 후 성공한 만큼 스냅샷 갱신 → 중간에 실패해도 다음 저장 때 남은 것만 다시 보냄
const _upsert = async (table, snapMap, rows) => {
  if (!rows.length) return;
  _pendEdit(p => rows.forEach(r => { p.rows[table][r.id] = r; delete p.del[table][r.id]; }));
  for (const part of _chunks(rows, CHUNK)) {
    _check(await _sb.from(table).upsert(part, { onConflict: "id" }));
    part.forEach(r => snapMap.set(r.id, JSON.stringify(r)));
    // 그 사이 더 새로운 수정이 대기 중이면 남겨둠
    _pendEdit(p => part.forEach(r => { if (JSON.stringify(p.rows[table][r.id]) === JSON.stringify(r)) delete p.rows[table][r.id]; }));
  }
};
const _softDelete = async (table, snapMap, ids) => {
  if (!ids.length) return;
  const at = new Date().toISOString();
  _pendEdit(p => ids.forEach(id => { p.del[table][id] = at; delete p.rows[table][id]; }));
  for (const part of _chunks(ids, CHUNK)) {
    _check(await _sb.from(table).update({ deleted_at: at }).in("id", part));
    part.forEach(id => snapMap.delete(id));
    _pendEdit(p => part.forEach(id => delete p.del[table][id]));
  }
};

const _flushPending = async () => {
  const p = _pendLoad();
  const n = _pendCount(p);
  if (!n) return;
  console.log("[storage] resending " + n + " pending item(s)");
  const dummy = new Map();
  await _upsert("companies", dummy, Object.values(p.rows.companies));
  await _upsert("transactions", dummy, Object.values(p.rows.transactions));
  await _softDelete("transactions", dummy, Object.keys(p.del.transactions));
  await _softDelete("companies", dummy, Object.keys(p.del.companies));
  for (const rec of Object.values(p.sigs)) await _uploadSigRec(rec);
};

const _initialLoad = async () => {
  await _flushPending();
  const [coRows, txRows] = await Promise.all([
    _fetchAll("companies", "id,name,manager,phone,reg_date,extra"),
    _fetchAll("transactions", "id,company_id,type,amount,description,occurred_at,staff,client_name,ppl,extra,sig_path,staff_sig_path,admin_sig_path"),
  ]);
  const cos = coRows.map(_rowToCo);
  const txs = txRows.map(_rowToTx);
  _snap.cos = new Map(cos.map(c => [c.id, JSON.stringify(_coToRow(c))]));
  _snap.txs = new Map(txs.map(t => [t.id, JSON.stringify(_txToRow(t))]));
  _sigRows = txRows.filter(r => r.sig_path || r.staff_sig_path || r.admin_sig_path);
  _loaded = true;
  return { cos, txs };
};

// 직전 metaSet에서 쓴 행이 서버에 실제로 반영됐는지 확인 (v19의 "저장 후 검증 읽기"를 대체)
const _verifyLastWrite = async () => {
  const w = _lastWrite;
  _lastWrite = null;
  if (w) {
    for (const [table, up, del] of [["companies", w.coUp, w.coDel], ["transactions", w.txUp, w.txDel]]) {
      const ids = [...up, ...del];
      for (const part of _chunks(ids, CHUNK)) {
        const rows = _check(await _sb.from(table).select("id,deleted_at").in("id", part));
        const byId = new Map(rows.map(r => [r.id, r]));
        for (const id of part) {
          const r = byId.get(id);
          const shouldExist = !del.includes(id);
          if (shouldExist && (!r || r.deleted_at)) throw new Error("서버 반영 확인 실패 (" + id + ")");
          if (!shouldExist && r && !r.deleted_at) throw new Error("서버 삭제 확인 실패 (" + id + ")");
        }
      }
    }
  }
  // 앱의 save()는 txs.length만 비교하므로 확인된 스냅샷 크기로 돌려준다
  return { cos: [..._snap.cos.keys()].map(id => ({ id })), txs: [..._snap.txs.keys()].map(id => ({ id })) };
};

// ===== v19 저장 함수 대체 (index.html에서 이 이름으로 호출) =====

// 최초 호출: 로그인 → 서버 전체 로드. 이후 호출(save의 검증 단계): 직전 쓰기 확인
const metaGet = async () => {
  await _ensureLogin();
  if (!_loaded) return _retryUntilOk(_initialLoad);
  return _verifyLastWrite();
};

// v: { cos, txs(서명 제외) } 전체 상태 → 직전 상태와 비교해 바뀐 행만 저장
const metaSet = async v => {
  await _ensureLogin();
  if (!_loaded) throw new Error("서버 데이터를 아직 불러오지 못했습니다");
  const diff = (items, toRow, snapMap) => {
    const next = new Map(items.map(x => [x.id, toRow(x)]));
    const up = [], del = [];
    for (const [id, row] of next) if (snapMap.get(id) !== JSON.stringify(row)) up.push(row);
    for (const id of snapMap.keys()) if (!next.has(id)) del.push(id);
    return { up, del };
  };
  const co = diff(v.cos || [], _coToRow, _snap.cos);
  const tx = diff(v.txs || [], _txToRow, _snap.txs);

  const delCount = co.del.length + tx.del.length;
  if (delCount >= MASS_DELETE_CONFIRM &&
      !confirm("⚠️ 서버에서 거래처 " + co.del.length + "개, 거래 " + tx.del.length + "건이 삭제 처리됩니다.\n(변경 이력에 남아 복구 가능)\n\n계속하시겠습니까?")) {
    throw new Error("대량 삭제 취소됨 - 새로고침하면 서버 상태로 돌아갑니다");
  }

  await _upsert("companies", _snap.cos, co.up);
  await _upsert("transactions", _snap.txs, tx.up);
  await _softDelete("transactions", _snap.txs, tx.del);
  await _softDelete("companies", _snap.cos, co.del);
  _lastWrite = { coUp: co.up.map(r => r.id), coDel: co.del, txUp: tx.up.map(r => r.id), txDel: tx.del };
  if (co.up.length + tx.up.length + delCount > 0) {
    console.log("[storage] saved: companies +" + co.up.length + "/-" + co.del.length + ", transactions +" + tx.up.length + "/-" + tx.del.length);
  }
};

// 서명: 서버에는 JPEG 파일로 저장, 앱에는 임시 URL로 전달 (<img src>에 그대로 사용됨)
// 초기 로드 때 1번 호출됨. 실패해도 앱 로드를 막지 않도록 예외를 던지지 않는다.
const sigsGetAll = async () => {
  try {
    const paths = [];
    _sigRows.forEach(r => Object.values(_SIG_KINDS).forEach(col => { if (r[col]) paths.push(r[col]); }));
    const urlByPath = new Map();
    for (const part of _chunks(paths, CHUNK)) {
      const res = _check(await _sb.storage.from(SIG_BUCKET).createSignedUrls(part, SIG_URL_TTL));
      res.forEach(x => { if (x.signedUrl) urlByPath.set(x.path, x.signedUrl); });
    }
    return _sigRows.map(r => {
      const rec = { txId: r.id };
      for (const [kind, col] of Object.entries(_SIG_KINDS)) rec[kind] = (r[col] && urlByPath.get(r[col])) || null;
      return rec;
    });
  } catch (e) {
    console.error("[storage] signature urls failed:", e);
    // 서명 경로가 있는 거래는 "저장됨"으로 표시해 다시 업로드하지 않게 함
    return _sigRows.map(r => ({ txId: r.id, sig: null, staffSig: null, adminSig: null }));
  }
};
const sigsGetAllKeys = async () => _sigRows.map(r => r.id);

const _dataUrlToBlob = d => {
  const [head, b64] = d.split(",");
  const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
};

// 서명 1건(거래 1개분) 업로드 → 거래 행에 경로 기록 → 전송 대기 목록에서 제거
async function _uploadSigRec(rec) {
  const cols = {};
  for (const [kind, col] of Object.entries(_SIG_KINDS)) {
    const v = rec[kind];
    if (typeof v !== "string" || !v.startsWith("data:")) continue;
    const blob = _dataUrlToBlob(v);
    const path = rec.txId + "/" + kind + (blob.type === "image/png" ? ".png" : ".jpg");
    _check(await _sb.storage.from(SIG_BUCKET).upload(path, blob, { upsert: true, contentType: blob.type }));
    cols[col] = path;
  }
  if (Object.keys(cols).length) _check(await _sb.from("transactions").update(cols).eq("id", rec.txId));
  _pendEdit(p => delete p.sigs[rec.txId]);
}

// arr: [{ txId, sig, staffSig, adminSig }] - 값이 data URL(새 서명)인 것만 업로드
// 거래 행은 metaSet에서 먼저 저장된 상태
const sigsPut = async arr => {
  await _ensureLogin();
  const fresh = arr.filter(rec => Object.keys(_SIG_KINDS).some(k => typeof rec[k] === "string" && rec[k].startsWith("data:")));
  if (!fresh.length) return;
  _pendEdit(p => fresh.forEach(rec => { p.sigs[rec.txId] = rec; }));
  const queue = fresh.slice();
  const worker = async () => { for (let rec; (rec = queue.shift());) await _uploadSigRec(rec); };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
};

// 거래는 소프트 삭제라 서명 파일도 보관 (복구 대비) → 아무것도 하지 않음
const sigsDelete = async () => {};
const sigsClear = async () => {};

// 로그아웃 (기기 교체 등): 브라우저 콘솔에서 jangbuLogout() 실행
window.jangbuLogout = async () => { if (_sb) await _sb.auth.signOut(); location.reload(); };

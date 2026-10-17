// 장부결제 백업 JSON → Supabase 이전 (1회용)
//
// 사용법:
//   node scripts/import.mjs <백업.json> --dry-run   # 서버 접속 없이 파일 검사만
//   node scripts/import.mjs <백업.json>             # 이전 + 검증
//   node scripts/import.mjs <백업.json> --verify    # 이전 없이 서버 데이터와 비교만
//
// 필요: 프로젝트 루트 .env 파일
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY=sb_secret_...   (대시보드 → Project Settings → API Keys → Secret key. 절대 커밋·배포 금지)
//
// 백업 파일: 기존 앱 설정 → "📥 수동 백업 (JSON)" 으로 받은 파일 (서명 포함)

import fs from "node:fs";
import path from "node:path";
import { loadMapping, connect, check, chunks, fetchAll, CO_COLS, TX_COLS } from "./lib.mjs";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
const DRY = args.includes("--dry-run");
const VERIFY_ONLY = args.includes("--verify");
const FORCE = args.includes("--force");
if (!file) { console.error("사용법: node scripts/import.mjs <백업.json> [--dry-run|--verify] [--force]"); process.exit(1); }

const { _coToRow, _rowToCo, _txToRow, _rowToTx, _SIG_KINDS } = loadMapping();

const stripSigs = t => { const r = { ...t }; for (const k of Object.keys(_SIG_KINDS)) delete r[k]; return r; };
// 키 순서와 무관하게 비교
const canon = o => JSON.stringify(Object.keys(o).sort().reduce((a, k) => (a[k] = o[k], a), {}));
const balances = txs => { const m = {}; for (const t of txs) m[t.cid] = (m[t.cid] || 0) + (t.type === "deposit" ? t.amount : -t.amount); return m; };
const sigPath = (txId, kind, dataUrl) => txId + "/" + kind + (dataUrl.startsWith("data:image/png") ? ".png" : ".jpg");

// ----- 1. 파일 검사 -----
const backup = JSON.parse(fs.readFileSync(file, "utf8"));
if (!Array.isArray(backup.cos) || !Array.isArray(backup.txs)) { console.error("❌ cos/txs 배열이 없는 파일입니다"); process.exit(1); }
const { cos, txs } = backup;
const coIds = new Set(cos.map(c => c.id));
const sigs = [];
for (const t of txs) for (const kind of Object.keys(_SIG_KINDS)) {
  const v = t[kind];
  if (typeof v === "string" && v.startsWith("data:")) sigs.push({ txId: t.id, kind, dataUrl: v });
}
const problems = [];
if (coIds.size !== cos.length) problems.push("거래처 ID 중복");
if (new Set(txs.map(t => t.id)).size !== txs.length) problems.push("거래 ID 중복");
const badType = txs.filter(t => !["deposit", "usage"].includes(t.type));
if (badType.length) problems.push("알 수 없는 거래 유형 " + badType.length + "건");
const badDate = txs.filter(t => !t.date || isNaN(new Date(t.date)));
if (badDate.length) problems.push("날짜 없는/잘못된 거래 " + badDate.length + "건");
const orphans = txs.filter(t => !coIds.has(t.cid));

// 변환 왕복 검사: 앱 객체 → DB 행 → 앱 객체가 원본과 같은지
const rtFail = [];
for (const c of cos) if (canon(_rowToCo(JSON.parse(JSON.stringify(_coToRow(c))))) !== canon(c)) rtFail.push(c.id);
for (const t of txs) {
  const row = JSON.parse(JSON.stringify(_txToRow(t)));
  if (canon(_rowToTx(row)) !== canon(stripSigs(t))) rtFail.push(t.id);
}
if (rtFail.length) problems.push("변환 왕복 불일치 " + rtFail.length + "건 (예: " + rtFail.slice(0, 3).join(", ") + ")");

console.log("📄 " + path.basename(file) + (backup._date ? " (백업 시각 " + backup._date + ")" : ""));
console.log("   거래처 " + cos.length + "개, 거래 " + txs.length + "건 (충전 " + txs.filter(t => t.type === "deposit").length + ", 사용 " + txs.filter(t => t.type === "usage").length + ")");
console.log("   서명 " + sigs.length + "장, " + (sigs.reduce((s, x) => s + x.dataUrl.length, 0) / 1024 / 1024).toFixed(2) + "MB (base64)");
console.log("   거래처 없는 거래 " + orphans.length + "건");
if (backup._auto) console.log("   ⚠️ 자동백업 파일입니다 (서명 미포함). 서명까지 옮기려면 수동 백업 파일을 쓰세요.");
if (problems.length) { console.error("❌ 문제: " + problems.join(" / ")); process.exit(1); }
console.log("✅ 파일 검사 통과 (변환 왕복 일치)");
if (DRY) process.exit(0);

// ----- 2. 서버 접속 -----
const sb = await connect();

// ----- 3. 이전 -----
if (!VERIFY_ONLY) {
  const { count, error } = await sb.from("transactions").select("id", { count: "exact", head: true });
  if (error) { console.error("❌ 서버 접속 실패: " + error.message); process.exit(1); }
  if (count > 0 && !FORCE) {
    console.error("❌ 서버에 이미 거래 " + count + "건이 있습니다. 운영 중인 데이터를 옛 백업으로 덮어쓸 수 있어 중단합니다.");
    console.error("   (같은 백업을 다시 넣는 경우라면 --force)");
    process.exit(1);
  }

  // 서명 업로드 (먼저 올리고, 성공한 경로만 거래 행에 기록)
  const uploaded = new Map(); // txId → { col: path }
  let done = 0, failed = 0;
  const queue = sigs.slice();
  const worker = async () => {
    for (let s; (s = queue.shift());) {
      const p = sigPath(s.txId, s.kind, s.dataUrl);
      const [head, b64] = s.dataUrl.split(",");
      const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
      const { error } = await sb.storage.from("signatures").upload(p, Buffer.from(b64, "base64"), { upsert: true, contentType: mime });
      if (error) { failed++; console.error("   서명 업로드 실패 " + p + ": " + error.message); continue; }
      const m = uploaded.get(s.txId) || {};
      m[_SIG_KINDS[s.kind]] = p;
      uploaded.set(s.txId, m);
      if (++done % 500 === 0) console.log("   서명 " + done + "/" + sigs.length);
    }
  };
  console.log("⬆️  서명 업로드 중...");
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log("   서명 업로드 " + done + "장 완료" + (failed ? ", 실패 " + failed + "장 (다시 실행하면 재시도)" : ""));

  console.log("⬆️  거래처/거래 저장 중...");
  for (const part of chunks(cos.map(_coToRow), 500)) check(await sb.from("companies").upsert(part, { onConflict: "id" }));
  const txRows = txs.map(t => ({ ...JSON.parse(JSON.stringify(_txToRow(t))), ...(uploaded.get(t.id) || {}) }));
  for (const part of chunks(txRows, 500)) check(await sb.from("transactions").upsert(part, { onConflict: "id" }));
  console.log("   저장 완료");
}

// ----- 4. 검증: 서버에서 다시 읽어 원본과 비교 -----
console.log("🔍 검증 중...");
const sCos = (await fetchAll(sb, "companies", CO_COLS)).map(_rowToCo);
const sTxRows = await fetchAll(sb, "transactions", TX_COLS);
const sTxs = sTxRows.map(_rowToTx);

const report = [];
const cmp = (label, local, server) => {
  const sm = new Map(server.map(x => [x.id, canon(x)]));
  const missing = local.filter(x => !sm.has(x.id));
  const diff = local.filter(x => sm.has(x.id) && sm.get(x.id) !== canon(x));
  report.push(label + ": 파일 " + local.length + " / 서버 " + server.length + (missing.length ? " / 누락 " + missing.length : "") + (diff.length ? " / 내용 다름 " + diff.length : ""));
  return missing.length + diff.length;
};
let bad = 0;
bad += cmp("거래처", cos, sCos);
bad += cmp("거래", txs.map(stripSigs), sTxs);

const lb = balances(txs), sbal = balances(sTxs);
const balDiff = [...new Set([...Object.keys(lb), ...Object.keys(sbal)])].filter(id => (lb[id] || 0) !== (sbal[id] || 0));
report.push("거래처별 잔액: " + (balDiff.length ? "불일치 " + balDiff.length + "곳" : "모두 일치"));
bad += balDiff.length;

const sigOnServer = sTxRows.reduce((n, r) => n + Object.values(_SIG_KINDS).filter(c => r[c]).length, 0);
const sigsMissing = sigs.filter(s => {
  const r = sTxRows.find(x => x.id === s.txId);
  return !r || !r[_SIG_KINDS[s.kind]];
}).length;
report.push("서명: 파일 " + sigs.length + "장 / 서버 기록 " + sigOnServer + "장" + (sigsMissing ? " / 누락 " + sigsMissing : ""));
bad += sigsMissing;

report.forEach(l => console.log("   " + l));
if (bad) { console.error("❌ 검증 실패 - 위 항목을 확인하세요"); process.exit(1); }
console.log("✅ 검증 통과: 파일과 서버 데이터가 일치합니다");

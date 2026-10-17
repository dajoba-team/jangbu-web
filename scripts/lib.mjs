// scripts 공용: storage.js 변환 함수 로드, .env 읽기, Supabase 클라이언트
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// storage.js의 변환 함수를 그대로 사용 (브라우저와 같은 규칙 보장)
export const loadMapping = () => {
  const src = fs.readFileSync(path.join(ROOT, "public", "storage.js"), "utf8") +
    "\nglobalThis.__m={_coToRow,_rowToCo,_txToRow,_rowToTx,_SIG_KINDS};";
  const ctx = { window: {}, console, document: undefined };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.__m;
};

// 환경변수 우선, 없으면 프로젝트 루트 .env
export const loadEnv = () => {
  const file = path.join(ROOT, ".env");
  const env = Object.fromEntries(
    (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#") && l.includes("="))
      .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
  );
  return {
    url: process.env.SUPABASE_URL || env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
  };
};

export const connect = async () => {
  const { url, key } = loadEnv();
  if (!url || !key) { console.error("❌ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY가 필요합니다 (.env 또는 환경변수)"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false } });
};

export const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
export const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// deleted=false면 삭제되지 않은 행만
export const fetchAll = async (sb, table, cols, { deleted = false } = {}) => {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols);
    if (!deleted) q = q.is("deleted_at", null);
    const rows = check(await q.order("id").range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
};

export const CO_COLS = "id,name,manager,phone,reg_date,extra";
export const TX_COLS = "id,company_id,type,amount,description,occurred_at,staff,client_name,ppl,extra,sig_path,staff_sig_path,admin_sig_path";

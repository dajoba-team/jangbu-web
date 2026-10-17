// 로그인 계정 비밀번호 변경 (관리자용, 로컬에서만 실행)
//
// 사용법: node scripts/set-password.mjs <이메일>
// 비밀번호는 화면에 표시되지 않게 두 번 입력받음. .env의 secret 키 필요.

import readline from "node:readline";
import { connect } from "./lib.mjs";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) { console.error("사용법: node scripts/set-password.mjs <이메일>"); process.exit(1); }

const askHidden = q => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); }; // 입력 글자는 출력하지 않음
  rl.question(q, ans => { rl.close(); process.stdout.write("\n"); resolve(ans); });
});

const sb = await connect();

// 이메일로 계정 찾기
let user = null;
for (let page = 1; !user; page++) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 100 });
  if (error) { console.error("❌ 계정 조회 실패: " + error.message); process.exit(1); }
  user = data.users.find(u => (u.email || "").toLowerCase() === email);
  if (data.users.length < 100) break;
}
if (!user) { console.error("❌ " + email + " 계정이 없습니다"); process.exit(1); }

const pw1 = await askHidden("새 비밀번호: ");
const pw2 = await askHidden("새 비밀번호 확인: ");
if (pw1 !== pw2) { console.error("❌ 두 비밀번호가 다릅니다"); process.exit(1); }
if (pw1.length < 8) { console.error("❌ 8자 이상으로 입력하세요"); process.exit(1); }

const { error } = await sb.auth.admin.updateUserById(user.id, { password: pw1 });
if (error) { console.error("❌ 변경 실패: " + error.message); process.exit(1); }
console.log("✅ " + email + " 비밀번호 변경 완료. 이미 로그인된 기기는 계속 로그인 상태로 유지됩니다.");

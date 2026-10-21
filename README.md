# 장부 관리 웹 서비스

식당 선결제 장부(충전/사용, 서명) 웹앱. v19.9(태블릿 IndexedDB 저장)를 v20(Supabase 서버 저장)으로 옮긴 버전.

`public/index.html`은 v19.9 원본에 v20 패치(저장 계층 교체, 잔액 계산 1회화, 기기 자동백업 중지, 설정 서버 저장, 백업 시 서명 이미지 포함)만 적용한 파일.

## 구조

```
public/            ← Netlify 배포 대상 (이 폴더만 공개됨)
  index.html       앱 화면 (v19.9 코드 거의 그대로, React UMD + 빌드 없음)
  storage.js       저장 계층: Supabase DB/Storage 저장, 로그인, 전송 대기 목록
supabase/
  schema.sql       테이블·보안 정책·변경 이력 트리거·서명 버킷 (새 프로젝트: SQL Editor에서 실행)
  002_settings.sql settings 테이블 추가 (기존 프로젝트에 추가 실행)
scripts/
  import.mjs       백업 JSON → Supabase 이전 (1회용)
  lib.mjs          스크립트 공용 (public/storage.js의 변환 규칙을 그대로 사용)
netlify.toml       배포 설정 (publish = public)
```

## 데이터 저장 방식

| 저장소 | 내용 | 앱 권한 (로그인 사용자) |
|---|---|---|
| `companies` 테이블 | 거래처 (이름, 담당자, 연락처, 등록일) | 읽기·추가·수정 |
| `transactions` 테이블 | 거래 (충전 `deposit` / 사용 `usage`, 금액, 일시, 식사자, 서명 경로) | 읽기·추가·수정 |
| `settings` 테이블 | v19.9 설정(`_cfg`) 한 행(`id='main'`): 충전요청 기준 금액, 정기 문자, 매장 홍보(사진 base64 포함). 변경 이력 미기록 | 읽기·추가·수정 |
| `audit_log` 테이블 | 위 두 테이블의 모든 추가·수정 이력 (변경 전/후 행, 변경 계정, 시각). DB 트리거가 자동 기록 | 읽기만 |
| Storage `signatures` 버킷 (비공개) | 서명 이미지 `{거래ID}/{sig\|staffSig\|adminSig}.jpg`. 거래 행에는 경로만 기록 | 읽기·업로드 |

- 거래처 담당자 연락처(`contacts`), 문자 이력(`smsLog`), 거래의 수기 입력(`backfilled`, `enteredAt`), 날짜 수정(`dateEditedFrom`) 등 컬럼에 없는 필드는 `extra`(jsonb)에 그대로 보관
- 잔액은 저장하지 않고 거래 합계(충전 − 사용)로 계산
- 삭제는 소프트 삭제(`deleted_at` 기록). 실제 DELETE는 정책상 불가, 서명 파일도 지우지 않음
- 실수 복구: `audit_log`의 `old_row`로 이전 값 확인 후 되돌리기
- 앱의 `save()`는 전체 상태를 넘기고, `storage.js`가 직전 상태와 비교해 바뀐 행만 전송
- 저장 실패 시 전송 대기 목록(localStorage)에 보관 → 다음 저장 또는 다음 실행 때 자동 재전송

## 키

| 키 | 위치 | 공개 |
|---|---|---|
| Publishable key (`sb_publishable_...`) | `public/storage.js` | 가능 (RLS로 보호, 로그인 필요) |
| Secret key (`sb_secret_...`) | `.env` (커밋 금지) | 불가 — 모든 보안 정책 우회 |

## 데이터 이전

```bash
npm install
cp .env.example .env   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(secret key) 입력
node scripts/import.mjs <수동백업.json> --dry-run   # 파일 검사만
node scripts/import.mjs <수동백업.json>             # 이전 + 검증
node scripts/import.mjs <수동백업.json> --verify    # 서버와 비교만
```

서버에 이미 거래가 있으면 덮어쓰기 방지를 위해 중단됨 (같은 백업 재실행은 `--force`).

## 계정

회원가입은 막혀 있음. Supabase 대시보드 → Authentication → Users → Add user 로 생성 (Auto Confirm 체크).

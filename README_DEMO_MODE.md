# 공개 데모 모드

공개 체험용 배포는 실제 Supabase와 분리한다. Vercel에서 **별도 프로젝트**를 만들고,
Production 환경변수로 아래 값만 설정한다.

```text
NEXT_PUBLIC_DEMO_MODE=true
```

그 Vercel 프로젝트에는 `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`를 넣지 않는다.
데모 모드에서는 이 값이 실수로 설정되어 있어도 앱이 `demo.invalid` 연결을 사용하며,
실제 Supabase에 연결하지 않는다.

## 공개 경로

- `/` → `/demo`
- `/demo` — 대시보드 체험
- `/demo/analytics` — 샘플 통계 체험

다른 페이지, API, Server Action 요청은 데모 모드에서 차단된다. 샘플 사업 18건과
지역명은 모두 가상 데이터이며, 실제 DB에서 읽지 않는다.

따라서 방문자는 앱 ID/PW 없이 탐색할 수 있다. Vercel의 Deployment Protection을
별도로 켜면 Vercel 로그인 또는 공유 링크 등 Vercel 수준의 접근 절차는 추가될 수 있다.

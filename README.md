# Trip ON AI Server Dashboard

Trip ON의 로컬 `gemma3:12b-it-qat` / Ollama 게이트웨이를 관리하는 정적 관리자 대시보드입니다.

## 관리자 로그인

GitHub Pages는 정적 파일만 제공하므로 **관리자 ID와 비밀번호를 이 저장소나 브라우저 코드에 저장하지 않습니다.** 로그인 폼은 배포된 관리자 API가 발급한 HttpOnly 세션 쿠키로만 작동합니다.

관리자 API는 다음을 보장해야 합니다.

- `POST /api/admin/login`: ID와 비밀번호 검증 후 HttpOnly, Secure, SameSite=Strict 세션 쿠키 발급
- `GET /api/admin/session`: 현재 세션 확인
- `POST /api/admin/logout`: 세션 종료
- 로그인 실패와 제어 명령에 속도 제한 적용
- 실제 관리자 비밀번호는 Worker 또는 로컬 게이트웨이의 비밀 환경 변수로만 보관
- Ollama `11434` 포트는 공개하지 않고, Cloudflare Tunnel은 인증된 게이트웨이만 연결

## API 계약

### GET `/api/servers`

```json
{
  "servers": [
    {
      "id": "local-gemma",
      "name": "로컬 Gemma 서버",
      "online": true,
      "cpu": 42,
      "ramUsedGb": 14.2,
      "ramTotalGb": 32,
      "gpu": 27,
      "vramUsedGb": 8.4,
      "vramTotalGb": 16,
      "gpuTempC": 63,
      "ollama": true,
      "gemma": true,
      "tunnel": true,
      "draining": false,
      "activeRequests": 1,
      "latencyMs": 1800,
      "lastSeen": "2026-09-23T12:00:00+09:00"
    }
  ]
}
```

### POST `/api/control`

```json
{
  "serverId": "local-gemma",
  "action": "restart_gateway"
}
```

지원 명령: `restart_gateway`, `restart_tunnel`, `drain`, `resume`, `restart_pc`, `shutdown`.

서버 제어는 이미 관리자 세션으로 인증된 요청만 허용해야 합니다. PC 재시작과 종료는 서버 측에서도 별도 확인·감사 로그를 적용해야 합니다.

## 배포 설정

기본값은 같은 오리진의 API입니다. API가 별도 Worker 도메인에 있다면, 배포 시 아래 전역 변수를 먼저 주입합니다.

```html
<script>window.TRIPON_ADMIN_API_BASE = "https://admin-api.example.workers.dev";</script>
```

이 값에는 비밀번호, Gateway 토큰, Ollama 주소를 넣지 않습니다.

## 관리자 API 배포

`worker/`는 GitHub Pages 대시보드의 세션 인증과 게이트웨이 프록시를 담당합니다. Worker 디렉터리에서 아래 Secret을 설정한 뒤 배포합니다.

```text
ADMIN_ID
ADMIN_PASSWORD
SESSION_SECRET
ADMIN_STATUS_URL
ADMIN_STATUS_TOKEN
ADMIN_CONTROL_URL
```

`ADMIN_ID`는 지정한 관리자 ID이고, `ADMIN_PASSWORD`는 관리자 비밀번호입니다. 실제 값은 `wrangler secret put` 또는 Cloudflare 대시보드의 Secret 관리 화면에만 입력합니다. GitHub 파일, 커밋, Actions 로그에는 절대 넣지 않습니다.

```bash
cd worker
npm install
wrangler secret put ADMIN_ID
wrangler secret put ADMIN_PASSWORD
wrangler secret put SESSION_SECRET
wrangler secret put ADMIN_STATUS_URL
wrangler secret put ADMIN_STATUS_TOKEN
wrangler deploy
```

배포된 Worker URL을 Pages에 연결하거나 `TRIPON_ADMIN_API_BASE`로 주입하면, 대시보드는 로그인 전에는 어떤 상태·제어 정보도 표시하지 않습니다.

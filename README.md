# CLIProxyAPI Wrapper (Express + Better Auth)

Bu servis, CLIProxyAPI uzerinden model cevaplarini sunar ve istemci kimlik dogrulamasi icin Better Auth kullanir.

## Ne var?

- Better Auth ile email/password login
- Better Auth API Key plugin ile kullaniciya API key uretme
- API key bazli dogrulama (`/ai/*`)
- API key bazli rate limit (hesap bazli)
- `gpt-5.3-codex` icin dedicated endpointler

## Kurulum

```bash
npm install
cp .env.example .env
```

`.env` icin zorunlu alanlar:

- `CLI_PROXY_API_KEY`
- `BETTER_AUTH_SECRET` (en az 32 karakter)

Opsiyonel ama onemli:

- `BETTER_AUTH_URL` (ornek: `http://localhost:4000`)
- `BETTER_AUTH_TRUSTED_ORIGINS` (ornek: `http://localhost:3000,http://127.0.0.1:3000`)
- `BETTER_AUTH_DATABASE_PATH` (ornek: `./data/better-auth.db`)
- `API_KEY_RATE_LIMIT_WINDOW_MS` (varsayilan: `86400000` -> 1 gun)
- `API_KEY_RATE_LIMIT_MAX` (varsayilan: `800`)

## Better Auth migration

Tablolari olusturmak icin bir kez calistir:

```bash
npm run auth:migrate
```

## Calistirma

```bash
npm run dev
```

veya

```bash
npm run build
npm start
```

## Endpointler

### Public

- `GET /health`
- `POST/GET /api/auth/*` (Better Auth route'lari)

### Protected (API key zorunlu)

- `GET /ai/models`
- `POST /ai/chat/completions`
- `POST /ai/responses`
- `POST /ai/codex-5.3/chat/completions`
- `POST /ai/codex-5.3/responses`

### Session Protected (login cookie)

- `GET /account/rate-limit` (hesap bazli rate limit ozet ve key bazli kullanim)

## Frontend akis (login -> API key -> AI)

1. `POST /api/auth/sign-up/email` (ilk kayit)
2. `POST /api/auth/sign-in/email` (login)
3. Cookie ile `POST /api/auth/api-key/create` (kullanici API key alir)
4. Donen `key` degerini sakla
5. `/ai/*` cagrilarinda `x-api-key: <key>` gonder

## Ornek cURL

Kayit:

```bash
curl -X POST http://localhost:4000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"name":"demo","email":"demo@example.com","password":"very-strong-password"}'
```

Login (cookie dosyasina yaz):

```bash
curl -X POST http://localhost:4000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -c cookie.txt \
  -d '{"email":"demo@example.com","password":"very-strong-password"}'
```

API key olustur:

```bash
curl -X POST http://localhost:4000/api/auth/api-key/create \
  -H 'Content-Type: application/json' \
  -b cookie.txt \
  -d '{"name":"frontend-key"}'
```

Model listesi:

```bash
curl http://localhost:4000/ai/models \
  -H 'x-api-key: <API_KEY>'
```

Codex 5.3 endpointi:

```bash
curl -X POST http://localhost:4000/ai/codex-5.3/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <API_KEY>' \
  -d '{"messages":[{"role":"user","content":"Merhaba"}],"stream":false}'
```

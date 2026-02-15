# CLIProxyAPI Wrapper (Express)

Bu servis, CLIProxyAPI'yi kendi frontend/backend katmaninla kullanman icin bir BFF API saglar.

Stack: TypeScript + Express + ESLint

## Ozellikler

- OpenAI-benzeri endpointleri proxyleme (`/models`, `/chat/completions`, `/responses`)
- Opsiyonel tek API key ile frontend -> senin API auth
- Sadece model endpointleri disariya acik (integrations route expose edilmez)

## Kurulum

```bash
npm install
cp .env.example .env
```

`.env` degerlerini doldur:

- `CLI_PROXY_BASE_URL` (ornek: `http://127.0.0.1:8317`)
- `CLI_PROXY_MANAGEMENT_KEY` (CLIProxyAPI management key)
- `CLI_PROXY_API_KEY` (CLIProxyAPI api key)
- `APP_API_KEY` (opsiyonel, bos birakirsan bu API auth istemez)

Calistir:

```bash
npm run build
npm start
```

Gelistirme:

```bash
npm run dev
```

Lint:

```bash
npm run lint
```

## Endpointler

### Health

- `GET /health`

### AI Proxy

- `GET /ai/models`
- `POST /ai/chat/completions`
- `POST /ai/responses`

## Ornek cURL

```bash
curl http://localhost:3000/ai/models \
  -H 'x-api-key: <APP_API_KEY>'
```

```bash
curl -X POST http://localhost:3000/ai/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <APP_API_KEY>' \
  -d '{
    "model": "gpt-5",
    "messages": [{"role":"user","content":"hello"}],
    "stream": false
  }'
```

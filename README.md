# FBR Middleware

Standalone service that receives invoice payloads from the invoicing app and submits them to FBR. Deploy on a VPS (e.g. Contabo) so the main app never holds FBR credentials.

## Contract

- **POST /api/submit**  
  - Header: `Authorization: Bearer <MIDDLEWARE_API_KEY>`  
  - Body: `{ "payload": <FBR DI request>, "fbrBaseUrl": "...", "fbrBearerToken": "..." }` (token/URL from company profile, sent by app)  
  - Success: `200` + `{ ok: true, invoiceNumber, dated, validationResponse }`  
  - Error: `4xx/5xx` + `{ ok: false, error, statusCode?, validationResponse? }`

- **GET /health** – returns `{ ok, middlewareKeySet }`.

## Env (on this server)

| Variable | Required | Description |
|----------|----------|-------------|
| `MIDDLEWARE_API_KEY` | Yes | Secret the **app** uses in `Authorization: Bearer <key>` |
| `PORT` | No | Default `3001` |

FBR base URL and bearer token are **not** stored on the middleware; the app sends `fbrBaseUrl` and `fbrBearerToken` in each request body (per company).

## Run locally

```bash
cp .env.example .env
# Edit .env with real values
npm install
npm start
```

## Deploy on VPS (e.g. Contabo)

See [../docs/FBR_INTEGRATION.md#deploying-on-a-vps-eg-contabo](../docs/FBR_INTEGRATION.md#deploying-on-a-vps-eg-contabo).

## App configuration

In the main app set (server env only):

- `FBR_MIDDLEWARE_URL=https://your-vps-domain-or-ip` (no trailing slash; app will call `/api/submit`)
- `FBR_MIDDLEWARE_API_KEY=<same value as MIDDLEWARE_API_KEY on this server>`

Each company sets its own FBR Base URL and FBR Bearer token in the Company profile. When the app calls the middleware, it sends that company's credentials in the request body.

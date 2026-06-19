# DigiPay UPG — Lifecycle Sandbox

A zero-backend, browser-only harness to walk through the **entire DigiPay UPG payment
lifecycle** one step at a time and prove the API contract end-to-end.

- **Nothing is stored on a server.** Credentials, tokens and purchase state live only in your
  browser's `localStorage`.
- The UI is a vertical **stepper**: each box appears once the previous step succeeds.

```
Login
  └─ Create Ticket            (providerId = time-based UUIDv8, auto-generated)
       └─ Redirect to Pay
            └─ Payment Result (callback)
                 └─ Verify
                      └─ [ Deliver | Reverse | Refund ]   ← sliding choice
                                                  └─ Track Refund (if refund)
```

The contract this implements is documented in the main repo at `docs/digipay.md`.

## Why a Cloudflare Worker?

Browsers **cannot call the DigiPay API directly** — there are no CORS headers, so `fetch()` to
`api.mydigipay.com` is blocked. A tiny **stateless** Worker solves both problems:

1. **`/api/*`** — CORS-proxies every API call (login/ticket/verify/…). Pick the environment with
   the `X-Digipay-Env: staging|production` header (the app sends it for you).
2. **`/cb`** — DigiPay POSTs the payment result to this URL (a browser navigation). The Worker
   reads the fields and `303`-redirects back to the SPA with the result in the URL **fragment**
   (`#cb=…`), which never reaches any server. The app decodes it and fills the callback box.

The Worker keeps no state — it only forwards and redirects.

> **Empirically confirmed:** DigiPay's API returns `Access-Control-Allow-Origin` **only for its
> own domain** (`www.mydigipay.com`). Tested third-party origins — including a real merchant
> (`www.digikala.com`) — get no ACAO, so the browser blocks the response. DigiPay is a
> server-to-server API; a proxy is unavoidable for any browser-based caller.

## Deploy

### 1. The static app (GitHub Pages)

Already served from this repo via GitHub Pages (root). URL:
`https://salehi.github.io/digipay/`

### 2. The Worker (Cloudflare, via Docker + wrangler)

No local Node needed — `wrangler.sh` runs wrangler inside Docker.

```bash
cd worker
cp cloudflare.credentials .env     # then fill CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
                                   # (.env and *.credentials are gitignored)
./wrangler.sh verify               # confirm the API token is valid
# edit wrangler.toml -> APP_URL if your Pages URL differs
./wrangler.sh deploy               # builds the wrangler-local image once, then deploys
```

This prints your Worker URL, e.g. `https://digipay-proxy.<you>.workers.dev`.
Other handy commands: `./wrangler.sh dev` (local on :8787), `./wrangler.sh tail` (live logs).

### 3. Wire them together

Open the app, and in the top **settings** bar:

- set **Worker proxy base URL** to your Worker URL,
- choose the **environment** (production / staging).

The Create-Ticket box auto-fills `callbackUrl` to `<worker>/cb`, so the result returns
automatically. (You can always paste the callback JSON manually instead.)

## Usage notes

- **providerId / refund providerId** are generated as time-based **UUIDv8** (sortable; 48-bit ms
  timestamp + random). Regenerate buttons are provided.
- **Verify is mandatory** — an unverified successful payment is auto-cancelled and refunded by
  DigiPay after a timeout.
- **Reverse vs Refund:** per purchase you may call *either* `reverse` (IPG/DPG only, within
  25 minutes) *or* `refund`, not both.
- **Deliver** is for credit/BNPL fulfilment only.
- **Reset all** in the settings bar clears every saved value from `localStorage`.

## Files

| Path | What |
|------|------|
| `index.html` | Stepper shell |
| `assets/styles.css` | Styling (dark theme, sliding choice control) |
| `assets/app.js` | All lifecycle logic, state, UUIDv8, Worker calls |
| `worker/worker.js` | Stateless CORS proxy + callback bounce |
| `worker/wrangler.toml` | Worker config (`APP_URL`) |
| `worker/wrangler.sh` | Docker-based wrangler wrapper (verify/deploy/dev/tail) |
| `worker/docker/Dockerfile` | Image with wrangler baked in (no local Node) |

> ⚠️ This is a **testing/diagnostic** tool. It puts real credentials in the browser and can hit
> the **production** DigiPay environment. Use responsibly.

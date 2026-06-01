# easy_host

Host an AI-generated webpage and install it on a phone as an app — no app store, no native build.

A single Cloudflare Worker that is three things at once:

1. **A PWA host.** It stores a self-contained HTML page and serves it back with the bits a phone needs to "Add to Home Screen" (web app manifest, service worker, apple meta tags) injected automatically.
2. **A backend for each app.** Every hosted app gets a per-app Durable Object (`AppBackend extends Agent`) exposing, via an injected `window.easyhost` SDK: persistent key/value **data** and real Web Push **notifications** — immediate, one-off scheduled, and recurring reminders that fire even when the app is closed.
3. **An MCP server (the "connector").** AI assistants like Claude call `publish_app` / `update_app` to publish or revise an app mid-conversation, and `get_build_guide` to learn how to build a good one.

There's also a plain web form (`/`) as a universal fallback for any AI that can't call connectors.

## The `easyhost` SDK (auto-injected into every app)

```js
await easyhost.ready
easyhost.data.get(key) / .set(key, value) / .delete(key) / .list(prefix?)   // persistent JSON store
easyhost.notify.installed            // is the PWA installed to the home screen?
easyhost.notify.permission           // 'default' | 'granted' | 'denied'
easyhost.notify.enable()             // request permission + subscribe (CALL FROM A CLICK)
easyhost.notify.sendNow({title, body})              // immediate
easyhost.notify.schedule({title, body, at})         // one-off (at = epoch ms / ISO)
easyhost.notify.every({title, body, everyMinutes})  // recurring; or { dailyAt: '08:30' }
easyhost.notify.list() / .cancel(id)
```

> **iOS push requires the PWA be installed** (Add to Home Screen, opened from the icon, iOS 16.4+). It does not work in a Safari tab. `enable()` must be triggered by a user gesture.

## How a user gets an app onto their phone

After a one-time connector setup in Claude:

1. Ask Claude to build an app → Claude generates HTML and calls `publish_app` → you get a link.
2. Open the link on your phone.
3. **Add to Home Screen** (iOS Safari) / **Install** (Android Chrome) → it launches fullscreen and works offline.

Fallback without a connector: open `/`, paste HTML, get the same link.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Manual upload form. |
| `POST /api/create` | `{ html, name?, theme_color? }` → `{ id, url }`. |
| `GET /s/:id/` | The hosted app, with PWA tags injected. (`/s/:id` 301-redirects here.) |
| `GET /s/:id/manifest.webmanifest` | Per-site web app manifest. |
| `GET /s/:id/sw.js` | Service worker (offline + Chrome installability). |
| `GET /s/:id/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | App icons (generated). |
| `GET /s/:id/sdk.js` | The injected `window.easyhost` client SDK. |
| `… /s/:id/api/config` | `{ vapidPublicKey, appId }` — SDK bootstrap. |
| `… /s/:id/api/data` (GET/PUT/DELETE) · `/api/data/list` | Per-app key/value store. |
| `… /s/:id/api/subscribe` · `/api/unsubscribe` · `/api/notify` | Push subscription + immediate send. |
| `… /s/:id/api/reminders` (POST/GET) · `/api/reminders/:id` (DELETE) | Scheduled / recurring reminders. |
| `POST /mcp` | MCP endpoint: `publish_app`, `update_app`, `get_build_guide` (+ `easyhost://guide` resource). (`/sse` for legacy SSE.) |

## Develop

```bash
npm install
npm run dev          # http://localhost:8787, fully local (no Cloudflare login needed)
```

## Deploy

```bash
# 1. Log in (interactive, opens a browser)
npx wrangler login

# 2. Create the KV namespace, then paste the printed id into wrangler.jsonc (kv_namespaces[0].id)
npx wrangler kv namespace create SITES

# 3. Deploy
npm run deploy
```

After the first deploy you'll get `https://easy-host.<your-account>.workers.dev`. Set that as
`PUBLIC_BASE_URL` in `wrangler.jsonc` and deploy once more, so the `publish_app` tool returns
absolute URLs. (The web form already returns absolute URLs without this.)

### Web Push secrets (VAPID)

Generate a P-256 VAPID keypair once and set three secrets (the public key is handed to clients;
the private JWK signs the VAPID JWT via `@pushforge/builder`):

```bash
# VAPID_PUBLIC_KEY   = raw P-256 public key, base64url
# VAPID_PRIVATE_JWK  = the private key as a JWK (JSON string)
# VAPID_SUBJECT      = mailto:you@example.com
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_JWK
npx wrangler secret put VAPID_SUBJECT
```

For local dev put the same three in `.dev.vars` (gitignored).

## Connect it to Claude

Settings → Connectors → **Add custom connector** → URL `https://easy-host.<your-account>.workers.dev/mcp`.
Then in a chat: *"make me a ... app and publish it"*. Works on Claude Free/Pro/Max/Team/Enterprise.

> ChatGPT note: custom write-capable connectors are limited to Business/Enterprise/Edu; individual
> Plus/Pro accounts can only use read/fetch connectors, so `publish_app` won't work there. Use the
> web form as the fallback on ChatGPT individual plans.

## Limitations (POC)

- **No auth** — anyone who can reach `/mcp`, `/api/create`, or an app's `/s/:id/api/*` can publish,
  write that app's data, and send pushes to its subscribers. Protection is the unguessable id only.
  Add OAuth (Cloudflare `workers-oauth-provider`) before exposing this widely.
- **No identity / single data bucket** — all visitors of an app share one `ns="shared"` data bucket;
  no per-user separation or cross-device login yet (the `ns` column is reserved for it).
- **Single self-contained HTML** — CSS/JS inline. Multi-file sites would need R2 instead of KV.

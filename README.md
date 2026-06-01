# easy_host

**Ask an AI to build you an app — and get a real, installable phone app with a backend.**

easy_host is a single [Cloudflare Worker](https://workers.cloudflare.com/) that turns any AI-generated HTML page into an installable [PWA](https://web.dev/learn/pwa) with **persistent storage** and **real push notifications** (including scheduled and recurring reminders that fire even when the app is closed). No app store, no native build, no separate backend to wire up.

Connect it to your AI assistant once, then just say *"make me a water-reminder app"* — the AI writes it, easy_host hosts it, and you Add to Home Screen. The notification that buzzes your phone every 2 hours is the thing a static page can never do.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ricky610329/easy_host)

## What it does

It's three things in one Worker:

1. **A PWA host** — stores a self-contained HTML page and serves it back with everything a phone needs to install it (web app manifest, service worker, apple meta tags, icons) injected automatically.
2. **A per-app backend** — every hosted app gets its own [Durable Object](https://developers.cloudflare.com/durable-objects/) exposing an injected `window.easyhost` SDK: a key/value **data store** and **Web Push notifications**.
3. **An MCP server (the "connector")** — AI assistants like Claude call `publish_app` / `update_app` to publish or revise an app mid-conversation, and `get_build_guide` to learn how to build a good one.

There's also a plain web form at `/` as a universal fallback for any AI that can't call connectors.

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

> **iOS push requires the PWA be installed** (Add to Home Screen, opened from the icon, iOS 16.4+). It does not work in a Safari tab, and `enable()` must be triggered by a user gesture. The build guide tells the AI to handle this.

## Deploy your own (2 minutes)

**One click:** use the **Deploy to Cloudflare** button above. It reads `wrangler.jsonc`, provisions a fresh KV namespace + Durable Objects, and lets you fill in variables as you deploy.

**Or from the CLI:**

```bash
git clone https://github.com/Ricky610329/easy_host && cd easy_host
npm install
npx wrangler login
npx wrangler kv namespace create SITES   # paste the printed id into wrangler.jsonc
npm run deploy
```

Set `PUBLIC_BASE_URL` (your `https://<worker>.<account>.workers.dev`) so the MCP tools return absolute URLs.

### Enable push notifications (VAPID)

Notifications need a [VAPID](https://datatracker.ietf.org/doc/html/rfc8292) key pair (the rest works without it):

```bash
node scripts/gen-vapid.mjs            # prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_JWK / VAPID_SUBJECT
echo -n '<VAPID_PUBLIC_KEY>'  | npx wrangler secret put VAPID_PUBLIC_KEY
echo -n '<VAPID_PRIVATE_JWK>' | npx wrangler secret put VAPID_PRIVATE_JWK
echo -n 'mailto:you@example.com' | npx wrangler secret put VAPID_SUBJECT
```

For local dev (`npm run dev`), put those three in a `.dev.vars` file (gitignored).

### Accounts (Google sign-in)

Publishing requires a signed-in account; the account owns its apps and gets a `/dashboard`. Create a
Google OAuth 2.0 **Web application** client and register these redirect URIs:

```
https://<your-worker>/auth/callback           # web session
https://<your-worker>/authorize/google-callback # MCP connector OAuth
http://localhost:8787/auth/callback              # local dev (optional)
http://localhost:8787/authorize/google-callback  # local dev (optional)
```

Then create the OAuth KV and set the secrets:

```bash
npx wrangler kv namespace create OAUTH_KV    # paste the id into wrangler.jsonc
echo -n '<client id>'     | npx wrangler secret put GOOGLE_CLIENT_ID
echo -n '<client secret>' | npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 32   | npx wrangler secret put COOKIE_SECRET   # session cookie signing
openssl rand -base64 32   | npx wrangler secret put CAP_SECRET      # per-app capability tokens
```

## Connect it to your AI

**Claude** (Free/Pro/Max/Team/Enterprise): Settings → Connectors → **Add custom connector** → `https://<your-worker>/mcp`. Adding it runs an OAuth flow — **sign in with Google** to authorize. Then in a chat: *"build me a ... app and publish it."* Claude calls `get_build_guide`, generates the HTML, calls `publish_app`, and the app is owned by your account (shows up in `/dashboard`).

> ChatGPT individual Plus/Pro can't use write-capable custom MCP connectors yet (Business/Enterprise/Edu only). Use the web form as the fallback there.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Manual upload form. |
| `POST /api/create` | `{ html, name?, theme_color? }` → `{ id, url }`. |
| `GET /s/:id/` | The hosted app, PWA tags injected. (`/s/:id` 301-redirects here.) |
| `GET /s/:id/{manifest.webmanifest, sw.js, sdk.js, icon-*.png}` | App assets (generated/injected). |
| `… /s/:id/api/{config, data, data/list, subscribe, unsubscribe, notify, reminders}` | The per-app backend the SDK talks to (authorized by a per-app capability token). |
| `GET /dashboard`, `GET/POST/DELETE /api/apps…` | Owner console (session-gated): list apps, set visibility, delete. |
| `/auth/{login,callback,logout}`, `/authorize`, `/token`, `/register` | Google web session + the MCP OAuth provider. |
| `POST /mcp` | MCP (OAuth-protected): `publish_app`, `update_app`, `get_build_guide` (+ `easyhost://guide` resource). |

## Security & limitations

- **Accounts gate publishing.** Both the web form and the MCP connector require Google sign-in; published apps are owned by that account. App visibility is `unlisted` (default, link-only), `private` (owner-only), or `public`.
- **Shared-origin isolation via capability tokens.** All apps share one origin, so `/s/:id/api/*` is authorized by a per-`(user, app)` token (not an ambient cookie) — a malicious app can't read another app's data. Per-app subdomain isolation is a planned hardening.
- **Notifications are per-app.** A Web Push subscription is bound to each app's service-worker scope, so enabling notifications is per-app (one account does not yet share one subscription across all its apps).
- **Single self-contained HTML only.** CSS/JS inline; no external CDNs (offline is a feature). Multi-file sites would need R2.
- **Hosted-demo kill-switch.** A public instance can be time-boxed or usage-capped via env vars (`SERVICE_OPEN`, `SERVICE_OPEN_UNTIL`, `MAX_APPS`) and a per-IP rate limit, so it can be left running safely and shut itself off. Unset on a self-hosted instance → unrestricted.

## Roadmap

- Unified notifications (one subscription across a user's apps, via a shared root service worker).
- AI inside apps (provider-agnostic), opt-in messaging channels (Telegram/Discord), realtime / multi-user, per-app subdomain isolation, multi-file apps (R2).

## License

[MIT](./LICENSE) © 2026 Ricky Tsou

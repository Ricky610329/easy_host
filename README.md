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

## Connect it to your AI

**Claude** (Free/Pro/Max/Team/Enterprise): Settings → Connectors → **Add custom connector** → `https://<your-worker>/mcp`. Then in a chat: *"build me a ... app and publish it."* Claude calls `get_build_guide`, generates the HTML, calls `publish_app`, and hands you a link.

> ChatGPT individual Plus/Pro can't use write-capable custom MCP connectors yet (Business/Enterprise/Edu only). Use the web form as the fallback there.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /` | Manual upload form. |
| `POST /api/create` | `{ html, name?, theme_color? }` → `{ id, url }`. |
| `GET /s/:id/` | The hosted app, PWA tags injected. (`/s/:id` 301-redirects here.) |
| `GET /s/:id/{manifest.webmanifest, sw.js, sdk.js, icon-*.png}` | App assets (generated/injected). |
| `… /s/:id/api/{config, data, data/list, subscribe, unsubscribe, notify, reminders}` | The per-app backend the SDK talks to. |
| `POST /mcp` | MCP: `publish_app`, `update_app`, `get_build_guide` (+ `easyhost://guide` resource). `/sse` for legacy clients. |

## Limitations (this is a POC — be aware before exposing it publicly)

- **No authentication.** Anyone who reaches `/mcp`, `/api/create`, or an app's `/s/:id/api/*` can publish, write that app's data, and send pushes to its subscribers. The only protection is the unguessable id. **Add auth (e.g. Cloudflare [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)) before any real exposure.**
- **No identity / single data bucket.** All visitors of an app share one data bucket; no per-user separation or cross-device login yet.
- **Single self-contained HTML only.** CSS/JS must be inline; no external CDNs (offline is a feature). Multi-file sites would need R2.
- **Hosted-demo kill-switch.** A public instance can be time-boxed or usage-capped via env vars (`SERVICE_OPEN`, `SERVICE_OPEN_UNTIL`, `MAX_APPS`) so it can be left running safely and shut itself off. Unset on a self-hosted instance → unrestricted.

## Roadmap

- **Google login** — a durable gate for the hosted instance, plus account-level identity so one push subscription covers all of a user's apps (replacing per-app enable).
- AI inside apps (provider-agnostic), opt-in messaging channels (Telegram/Discord), realtime / multi-user, per-user private data.

## License

[MIT](./LICENSE) © 2026 Ricky Tsou

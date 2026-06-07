# easy_host

*The codebase behind **ship it** 🚀 — [ship-it-app.com](https://ship-it-app.com).*

**Ask an AI to build you an app — and get a real, installable phone app with a backend.**

**Demo:** _(video coming)_ · **Live:** [ship-it-app.com](https://ship-it-app.com)

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
// persistent cloud store (per signed-in user, survives reinstall):
easyhost.data.get(key) / .set(key, value) / .delete(key)
easyhost.data.list(prefix, { keysOnly, limit, reverse }) / .count(prefix)
// Web Push (scheduled/recurring reminders fire server-side, even when the app is closed):
easyhost.notify.installed / .permission                        // install state / 'default'|'granted'|'denied'
easyhost.notify.enable()                                       // request permission + subscribe (CALL FROM A CLICK)
easyhost.notify.sendNow({title, body, icon?, image?})          // immediate; per-notification icon/image
easyhost.notify.schedule({title, body, at})                    // one-off (at = epoch ms / ISO)
easyhost.notify.every({title, body, everyMinutes})             // recurring; or { dailyAt: '08:30' } (user's LOCAL time)
easyhost.notify.every({bodies:[...], everyMinutes, tag})       // rotate content; `tag` upserts (no duplicate reminders)
easyhost.notify.list() / .cancel(id) / .cancelByTag(tag)
easyhost.notify.onClick((url) => { /* deep-link on notification tap */ })
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
| `GET /`, `GET /how` | Manual upload form + "how it works" walkthrough. |
| `POST /api/create` | `{ html, name?, theme_color? }` → `{ id, url }` (form path, single-file). |
| app serving | Custom domain → `https://<id>.<domain>/` (own origin); `/s/:id/` 301-redirects there. On `*.workers.dev`/`localhost` → served at `/s/:id/`. Unknown paths fall back to `index.html` (SPA). |
| `…/{manifest.webmanifest, sw.js, sdk.js, icon-*.png}` + any app file | Injected app assets + the app's own files (multi-file). Sign-in-gated for private apps. |
| `…/api/{config, data, data/list, data/count, subscribe, unsubscribe, notify, reminders}` | Per-app backend the SDK talks to (per-`(user,app)` capability token). |
| `GET /dashboard`, `GET/POST/DELETE /api/apps…` | Owner console (session-gated): list apps, set visibility, delete. |
| `/auth/{login,callback,logout}`, `/authorize`, `/token`, `/register` | Google web session + the MCP OAuth provider. |
| `POST /mcp` | MCP (OAuth-protected): `publish_app`, `update_app`, `get_build_guide` (+ `easyhost://guide` resource). |
| `POST /admin/{block,unblock,close,open}` | Operator (Bearer `ADMIN_TOKEN`): take down an app / kill-switch the whole site. |
| `/robots.txt`, `/sitemap.xml`, `/favicon.ico` | SEO + brand (marketing pages indexable; app subdomains are `noindex`). |

## Security & limitations

- **Sign-in is required to open ANY app** (not just to publish), so each visitor gets their own private data namespace. Visibility is `private` (default — owner only) or `public` (any signed-in user). Published apps are owned by the signing-in account.
- **Per-app subdomain isolation.** Each app is served from its own origin `<id>.<domain>` (account/auth/MCP stay on the apex). `/s/:id/api/*` is also authorized by a per-`(user, app)` capability token, and every file of a private app is sign-in-gated so its JS/CSS can't leak. (Self-hosting on `*.workers.dev`/`localhost` falls back to same-origin `/s/:id/` path mode.)
- **Notifications are per-app.** A Web Push subscription is bound to each app's service-worker scope. Notifications reach only the signed-in user's own devices — there is no user-to-user delivery (by design, we don't hold/relay user data).
- **Apps can be one HTML file or several text files.** `publish_app` takes `html` (single-file) or a `files` list (multi-file: index.html entry + js/css/nested modules, SPA routing). Text files only; images via URL/CDN/data: URI. The network is available (external APIs, iframes, CDNs).
- **Cost controls.** Stay on the Workers Free plan for a hard $0 ceiling. A friendly site-wide "oops" page + an instant operator kill (`POST /admin/close|/admin/open`), an optional usage **auto-shutoff** cron (`DAILY_REQUEST_BUDGET` + `CF_API_TOKEN`/`CF_ACCOUNT_ID` read Cloudflare analytics and close the site for the day if exceeded), the publishing kill-switch (`SERVICE_OPEN`/`SERVICE_OPEN_UNTIL`/`MAX_APPS`), and per-IP rate limits. All opt-in — unset on a self-hosted instance → unrestricted.

## Roadmap

- Notification action buttons (one-tap "Message"/"Snooze"), round-robin rotation, image-icon upload, quiet hours.
- Publish-time preview / runtime-error detection (needs browser rendering).
- Binary assets via R2 (today: text files + URL/CDN/data: URIs).

Out of scope by design: holding/relaying user data (no server-side messaging/inbox). Per-app subdomain
isolation, multi-file apps, unified per-user data, and the cost auto-shutoff are **done**.

## License

[MIT](./LICENSE) © 2026 Ricky Tsou

---

_Not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic; easy_host simply connects to it as an MCP connector. Bring your own API keys and Cloudflare account._

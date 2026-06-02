# ship it 🚀 — current state & pre-launch checklist

**ship it** (easy_host) — a single Cloudflare Worker that hosts AI-generated web apps as installable
phone PWAs, with a backend (cloud data + real push). Build via the Claude MCP connector or a paste form.
Domain: **ship-it-app.com**. Connector: **https://ship-it-app.com/mcp**.

## What it does

| Area | Capability |
|---|---|
| **Build** | Claude connector (`publish_app`: `html` OR `files` list; `update_app`: per-file merge patch) · paste form (single-file) |
| **App** | Installable PWA (injected manifest/SW/icons/SDK/base), own subdomain `<id>.ship-it-app.com`, offline-capable, network allowed (external APIs/iframes/CDN), no accidental double-tap-zoom |
| **Multi-file** | `index.html` entry + js/css/nested files; SPA routing (hash + History API); ≤20 files, ≤2 MB |
| **Data** | `easyhost.data` — cloud (DO SQLite), per-(app,user): get/set/delete/list({keysOnly,limit,reverse})/count. 64 KB/value, 1000 keys |
| **Notify** | `easyhost.notify` — sendNow / schedule(at) / every(everyMinutes \| dailyAt **local time**) / list / cancel / cancelByTag. Per-notification icon/image/badge, rotating `bodies`, `tag` upsert, `onClick` deep-link. Fires server-side when closed. iOS needs install-first. Caps: 50 reminders, ~30/min |
| **Accounts** | Google sign-in; **opening any app requires sign-in**; private (owner only) / public (any signed-in user, own private data); dashboard |
| **SEO** | Marketing pages indexable + /robots.txt + /sitemap.xml; app subdomains noindex + Disallow |

## Security (audited "safe to ship")
- Per-app subdomain isolation + Origin check; per-(app,user) capability tokens; constant-time HMAC.
- Every app file is gated by sign-in (a private app's JS/CSS can't leak); path-traversal-safe; reserved paths win.
- Private app's manifest name redacted for non-owners; reminder ops are namespace-scoped; open-redirect closed.
- **Known residual (low):** `getSite` 5 s isolate cache → after a public→private flip, other isolates may serve content to non-owners for ≤5 s.

## Cost protection
- Staying on the Workers **Free plan = hard $0 ceiling** (over-limit errors, never billed).
- Friendly site-wide **oops page**; instant operator kill `POST /admin/close|/admin/open`.
- **Auto-shutoff cron** (armed): a `*/15` job reads Cloudflare request analytics; if a UTC day exceeds
  `DAILY_REQUEST_BUDGET` (=80000) it closes the site, auto-recovers next day. Fail-safe on read error.
- Quotas: 100 apps/user, per-IP rate limit; `getSite`/`isBlocked` isolate caches keep KV reads low.

## Tests
- `npm test` → 45 vitest (util crypto/tokens/cron, files path-safety/limits, store routing/visibility, auth/safeNext).
- Multi-file + notify pipeline runtime-verified locally (serving, content-types, SPA fallback, gating, ns-scoping).

## Not built (by design / deferred)
- **No user-to-user messaging / social** — we deliberately don't hold or relay user data (maybe p2p someday).
- Deferred: notification action buttons, round-robin rotation, image-icon upload, quiet hours,
  publish-time preview / runtime-error detection (need Browser Rendering — Workers blocks eval/new Function).

## Operator config (secret NAMES — values are not in the repo)
VAPID_PUBLIC_KEY / VAPID_PRIVATE_JWK / VAPID_SUBJECT · COOKIE_SECRET · CAP_SECRET ·
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET · ADMIN_TOKEN · CF_API_TOKEN / CF_ACCOUNT_ID · DAILY_REQUEST_BUDGET.

## Pre-HN checklist (operator)
1. **Reconnect the MCP connector** in Claude (remove + re-add) so the cached tool schema refreshes and
   `files` (multi-file) is usable. (It was disconnected during dev.)
2. **Submit the sitemap** in Google Search Console: `https://ship-it-app.com/sitemap.xml`.
3. **Phone test**: open a published app signed-in → Add to Home Screen → enable notifications → receive a push.
4. Branch `feat/pwa-host-mcp-connector` is **not merged to main**; GitHub repo still **private**
   (README/LICENSE say MIT but aren't shown on the site). Decide clean-repo / open-source timing.
5. Optional at launch: set `MAX_APPS` / `SERVICE_OPEN_UNTIL`; rotate `ADMIN_TOKEN` before going public.

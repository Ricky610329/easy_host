# easy_host

Host an AI-generated webpage and install it on a phone as an app — no app store, no native build.

A single Cloudflare Worker that is two things at once:

1. **A PWA host.** It stores a self-contained HTML page and serves it back with the bits a phone needs to "Add to Home Screen" (web app manifest, service worker, apple meta tags) injected automatically.
2. **An MCP server (the "connector").** AI assistants like Claude can call its `publish_app` tool to publish a page directly mid-conversation and hand the user a link.

There's also a plain web form (`/`) as a universal fallback for any AI that can't call connectors.

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
| `POST /mcp` | MCP endpoint exposing `publish_app`. (`/sse` for legacy SSE clients.) |

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

## Connect it to Claude

Settings → Connectors → **Add custom connector** → URL `https://easy-host.<your-account>.workers.dev/mcp`.
Then in a chat: *"make me a ... app and publish it"*. Works on Claude Free/Pro/Max/Team/Enterprise.

> ChatGPT note: custom write-capable connectors are limited to Business/Enterprise/Edu; individual
> Plus/Pro accounts can only use read/fetch connectors, so `publish_app` won't work there. Use the
> web form as the fallback on ChatGPT individual plans.

## v1 limitations

- **No auth** — anyone who can reach `/mcp` or `/api/create` can publish. Protection is the
  unguessable site id only. Add OAuth (Cloudflare `workers-oauth-provider`) before exposing this widely.
- **Single self-contained HTML** — CSS/JS should be inline. Multi-file sites / external relative
  assets would need R2 instead of KV.

# Multi-file apps — implementation plan

Lift the "single self-contained HTML" constraint: an app can be several text files
(`index.html` + `app.js` + `styles.css` + more), served from its isolated subdomain.

## Principles
- **Single-file is a special case**: internally always a files map; `html` is sugar for
  `{ "index.html": html }`. Existing single-file apps + the paste form keep working, no migration.
- **Text files only** (html/js/css/json/svg/txt). Binary/images go via URL/CDN/data-URI (network is allowed).
- Each app is its own subdomain → its root is `/`, so multi-file routing is natural.

## Data model
- `Site.files?: Record<string,string>` (path → text). Keep `Site.html` (read: no `files` ⇒ `{ index.html: html }`).
- Entry point fixed: `index.html` (validated on publish).

## Serving / routing (`<id>.ship-it-app.com/<path>`)
1. **Reserved paths win** (ours, injected): `/api/*`, `/sw.js`, `/sdk.js`, `/manifest.webmanifest`,
   `/icon-*.png`, `/apple-touch-icon.png`, `/robots.txt`. App files at these are shadowed (lint warns).
2. Otherwise look up the file:
   - hit → serve raw with content-type by extension, **no head injection**.
   - `/`, `""`, or **miss** (SPA fallback) → `index.html` **with** head injection + capability token.
- ⚠️ **Gate EVERY file** with `canOpenApp` (not just HTML): a private app's `app.js` must not leak.
  Session cookie is sent to subdomains (Domain=apex), so this is a cheap cookie check per file.
- ⚠️ **base href = absolute app root** (`/` in subdomain mode, `/s/:id/` in path mode), not `./`,
  so deep SPA routes (`/chat/123`) still load `app.js` correctly. Verify single-file apps unaffected.
- ⚠️ **content-type**: `.js/.mjs → text/javascript` (required for ESM `import`); unknown → `text/plain`
  (never `text/html`).
- ⚠️ **path safety**: normalize, reject `..`, leading `/`, `\`, `//`, NUL, non-whitelist chars, >256 chars.

## Cost
- ⚠️ Multi-file = more `getSite` (KV reads) per load. Add a ~5s isolate cache to `getSite`, busted by
  `putSite`/`delSite`. Collapses a load's many file requests into one KV read. (≤5s staleness after update.)

## MCP tools
- `publish_app`: accept `files` (map) OR `html` (single, back-compat). `files` ⇒ require `index.html`.
- `update_app`: **per-file patch** — `files` merges (upsert changed files), `removeFiles:[...]` deletes,
  `html` ⇒ replace `index.html`. Big win: change one file without resending the whole app.
- Validate via `sanitizeFiles` (paths/types/reserved/count/size). Lint runs over all files.

## Limits
- ≤20 files, ≤2 MB total, extension whitelist, reserved-path rejection, path length cap.

## Back-compat
- Single-file (`Site.html`) + paste form unchanged. **Paste form stays single-file** (multi-file is via the AI connector).

## Testing (pure + runtime)
- Pure (vitest): `normalizeFilePath`, `requestToFileKey`, `contentTypeFor`, `isReservedAppPath`,
  `sanitizeFiles`, `mergeFiles`, `siteFiles` — incl. path-traversal attempts.
- Runtime (minted token + seeded site): `/app.js` JS type + raw; `/` injected; deep route → index.html;
  `/../x` → 404; **private app's `/app.js` blocked when not signed in**.

## Phases
- P1: data model + serving (file lookup / gate-all / fallback / absolute base) + content-types + limits + `publish_app files`.
- P2: `update_app` per-file patch.
- P3: build-guide multi-file section + lint warnings.

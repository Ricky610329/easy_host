# Roadmap / known rough edges

Feedback from real publishing sessions (an AI building apps through the connector), with honest
feasibility notes. Not all of this is on the server — see the reality check first.

## Reality check: we're a *remote* MCP server
The connector runs on Cloudflare; the AI's generated files live in **its own sandbox**, which we
**cannot read**. So "let `publish_app` take file *paths*" isn't possible from here — the client would
still have to read each file and send its content. The realistic fixes for the truncation / retype /
"had to split files" pain are **smaller payloads** (patching, per-file ops), not server-side file access.

## update_app (highest-value bucket)
- [ ] **`str_replace` patches** — `update_app({ id, edits:[{path, old, new}] })` so a one-line change
      doesn't resend a 15KB file. Biggest win for token cost + truncation risk. (Today: whole-file merge.)
- [x] **`get_app(id)`** — returns the current files (path, size, content) so the AI can read live state, edit precisely, and confirm what's deployed.
- [x] **dry-run** — `publish_app`/`update_app` take `dryRun` to validate without saving.
- [ ] **versioning / rollback** — revert to the previous version after a bad deploy.
- [x] merge-only-changed-files (already shipped; whole-file granularity).

## publish_app
- [ ] **Atomicity** — a truncated transfer must be all-or-nothing; never leave a half-app, always
      return an id or a clear failure so the AI knows whether anything was created.
- [ ] **Pre-publish validation** — parse the HTML and reject obvious breakage with a message instead
      of silently going live. (JS *syntax* check is hard: Workers block `eval`/`new Function`; a real
      check needs browser rendering — see below.)
- [x] **Per-file byte counts in the response** — publish/update now append a `Files: …` size line.

## get_build_guide
- [ ] State the hard limits up front (≤20 files, ~2MB total, ~64KB/value, 1000 keys) **and** a suggested
      per-call payload size, so the AI knows to split before it gets truncated.
- [ ] Say explicitly: "the server does NOT check your JS — validate it yourself." (Set expectations.)

## Bigger bets (need a headless browser — Cloudflare Browser Rendering)
- [ ] **Post-publish health check** — fetch each asset (200?), load index.html, report console errors,
      so the AI gets a feedback loop instead of guessing why a button doesn't work.
- [ ] **Preview + console-log capture** — let the AI reproduce "slow to load / button dead" and debug
      itself. This + runtime JS validation are the same investment.

## Priority
1. `str_replace` patches (update_app) — cheap-ish, huge ergonomic win.
2. `get_app(id)` read + dry-run + per-file bytes — small, high clarity.
3. Atomicity + pre-publish HTML parse — robustness.
4. Browser-rendering bets (health check / preview / JS runtime validation) — largest, do last.

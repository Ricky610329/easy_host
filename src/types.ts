import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AppBackend } from "./backend";

export interface Env {
  SITES: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  APP_OBJECT: DurableObjectNamespace<AppBackend>;
  PUBLIC_BASE_URL?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK: string;
  VAPID_SUBJECT: string;
  // Hosted-demo kill-switch (all optional; unset => unrestricted, so self-hosters are unaffected).
  SERVICE_OPEN?: string; // "false" closes new publishing
  SERVICE_OPEN_UNTIL?: string; // ISO timestamp; publishing closes after it
  MAX_APPS?: string; // numeric cap on total published apps (whole instance)
  MAX_APPS_PER_USER?: string; // numeric cap on apps per account
  // Cost auto-shutoff (optional): a cron reads Cloudflare's own request analytics and, if today's
  // request count exceeds DAILY_REQUEST_BUDGET, hard-closes the whole site (an "oops" page) until
  // the next UTC day. Unset => disabled (manual /admin/close still works).
  DAILY_REQUEST_BUDGET?: string; // numeric daily request ceiling for the whole worker
  CF_API_TOKEN?: string; // Cloudflare API token with Account Analytics:Read
  CF_ACCOUNT_ID?: string; // Cloudflare account id (the analytics are account-scoped)
  // Accounts (Google): web session + MCP OAuth.
  OAUTH_KV: KVNamespace; // used by @cloudflare/workers-oauth-provider
  OAUTH_PROVIDER: OAuthHelpers; // injected by the provider into env
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  COOKIE_SECRET: string; // HMAC key for the session cookie
  CAP_SECRET: string; // HMAC key for per-(user,app) capability tokens
  ADMIN_TOKEN?: string; // bearer token for operator /admin/* takedown endpoints
}

export interface SessionUser {
  id: string; // Google sub
  email: string;
}

export interface Site {
  html?: string; // single-file app (legacy/paste-form); read via siteFiles() as { "index.html": html }
  files?: Record<string, string>; // multi-file app: path -> text content (entry = index.html)
  name?: string;
  theme_color?: string;
  icon?: string; // optional monogram char(s) for the generated lettermark icon
  owner?: string; // Google sub of the publisher; undefined => legacy/anonymous
  visibility?: "private" | "public"; // default private; anything not "private" serves openly by link
}

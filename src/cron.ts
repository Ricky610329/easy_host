// Cost auto-shutoff: a scheduled (cron) handler that reads Cloudflare's OWN request analytics for
// this worker and, if today's request count crosses DAILY_REQUEST_BUDGET, hard-closes the site until
// the next UTC day. We read analytics that Cloudflare already collects (free, accurate) instead of
// counting requests ourselves (a per-request KV write would itself burn the free-plan budget).
//
// Entirely opt-in: if DAILY_REQUEST_BUDGET / CF_API_TOKEN / CF_ACCOUNT_ID are not all set, this is a
// no-op and the only kill-switch is the manual /admin/close. So self-hosters are unaffected.
import type { Env } from "./types";
import { setServiceClosedAuto } from "./store";

const SCRIPT_NAME = "easy-host"; // must match wrangler.jsonc "name"

const REQUESTS_QUERY = `
query ($accountTag: string!, $start: Time!, $end: Time!, $script: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(
        limit: 1
        filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $script }
      ) {
        sum { requests }
      }
    }
  }
}`;

async function todaysRequestCount(env: Env): Promise<number | null> {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: REQUESTS_QUERY,
      variables: { accountTag: env.CF_ACCOUNT_ID, start: start.toISOString(), end: now.toISOString(), script: SCRIPT_NAME },
    }),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  const rows = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(rows)) return null;
  return rows.reduce((sum: number, r: any) => sum + (r?.sum?.requests || 0), 0);
}

export async function handleScheduled(env: Env): Promise<void> {
  const budget = env.DAILY_REQUEST_BUDGET ? parseInt(env.DAILY_REQUEST_BUDGET, 10) : 0;
  if (!budget || !env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return; // auto-shutoff disabled
  try {
    const count = await todaysRequestCount(env);
    if (count === null) return; // analytics unavailable this run — leave the flag as-is
    await setServiceClosedAuto(env, count >= budget);
  } catch {
    // Never let a failed analytics read flip the site closed; leave the current state.
  }
}

// Per-app backend Durable Object: key/value data store + push subscriptions + scheduled notifications.
import { Agent } from "agents";
import { buildPushHTTPRequest } from "@pushforge/builder";
import type { Env } from "./types";
import { dailyAtToCron, sha256hex } from "./util";

export type ApiResult = { status: number; json: unknown };

const PUSH_TTL = 3600;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_KEYS = 1000; // per ns, to bound storage
const MAX_REMINDERS = 50; // per app, to bound DO alarm usage
const NOTIFY_PER_MIN = 30; // immediate-send rate cap per app

export class AppBackend extends Agent<Env> {
  private schemaReady = false;
  private rlWin = 0; // fixed 1-min window for immediate-notify rate limiting
  private rlN = 0;

  private notifyAllowed(): boolean {
    const w = Math.floor(Date.now() / 60000);
    if (w !== this.rlWin) {
      this.rlWin = w;
      this.rlN = 0;
    }
    if (this.rlN >= NOTIFY_PER_MIN) return false;
    this.rlN++;
    return true;
  }

  private ensure() {
    if (this.schemaReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, ns TEXT, endpoint TEXT, p256dh TEXT, auth TEXT, created INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS kv (ns TEXT, k TEXT, v TEXT, updated INTEGER, PRIMARY KEY (ns, k))`;
    this.schemaReady = true;
  }

  // Single RPC entrypoint the Worker forwards /s/:id/api/* calls to.
  async apiCall(method: string, path: string, query: Record<string, string>, body: any, appId: string, userNs?: string): Promise<ApiResult> {
    this.ensure();
    const ns = userNs || "shared"; // signed-in user id, or "shared" for anonymous (keeps legacy data resolvable)
    try {
      if (path === "config" && method === "GET") {
        return { status: 200, json: { vapidPublicKey: this.env.VAPID_PUBLIC_KEY || "", appId, userId: ns } };
      }
      if (path === "subscribe" && method === "POST") {
        const sub = body?.subscription;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return { status: 400, json: { error: "bad subscription" } };
        const id = await sha256hex(sub.endpoint);
        this.sql`INSERT OR REPLACE INTO subs (id, ns, endpoint, p256dh, auth, created) VALUES (${id}, ${ns}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth}, ${Date.now()})`;
        return { status: 200, json: { ok: true } };
      }
      if (path === "unsubscribe" && method === "POST") {
        if (body?.endpoint) {
          const id = await sha256hex(body.endpoint);
          this.sql`DELETE FROM subs WHERE id = ${id}`;
        }
        return { status: 200, json: { ok: true } };
      }
      if (path === "notify" && method === "POST") {
        if (!this.notifyAllowed()) return { status: 429, json: { error: "notify rate limit (30/min)" } };
        return { status: 200, json: { sent: await this.sendToAll(ns, body || {}) } };
      }
      if (path === "reminders" && method === "POST") {
        return { status: 200, json: { id: await this.scheduleReminder(ns, body || {}) } };
      }
      if (path === "reminders" && method === "GET") {
        return { status: 200, json: { items: await this.listReminders(ns) } };
      }
      if (path.startsWith("reminders/") && method === "DELETE") {
        await this.cancelSchedule(decodeURIComponent(path.slice("reminders/".length)));
        return { status: 200, json: { ok: true } };
      }
      if (path === "data" && method === "GET") {
        const rows = this.sql<{ v: string }>`SELECT v FROM kv WHERE ns = ${ns} AND k = ${query.key || ""}`;
        return { status: 200, json: { value: rows.length ? JSON.parse(rows[0].v) : null } };
      }
      if (path === "data" && method === "PUT") {
        const k = String(body?.key ?? "");
        if (!k) return { status: 400, json: { error: "key required" } };
        const v = JSON.stringify(body?.value ?? null);
        if (v.length > MAX_VALUE_BYTES) return { status: 413, json: { error: "value too large" } };
        const exists = this.sql`SELECT 1 FROM kv WHERE ns = ${ns} AND k = ${k}`.length > 0;
        if (!exists) {
          const cnt = this.sql<{ c: number }>`SELECT COUNT(*) AS c FROM kv WHERE ns = ${ns}`[0].c;
          if (cnt >= MAX_KEYS) return { status: 413, json: { error: "too many keys (max 1000)" } };
        }
        this.sql`INSERT OR REPLACE INTO kv (ns, k, v, updated) VALUES (${ns}, ${k}, ${v}, ${Date.now()})`;
        return { status: 200, json: { ok: true } };
      }
      if (path === "data" && method === "DELETE") {
        this.sql`DELETE FROM kv WHERE ns = ${ns} AND k = ${query.key || ""}`;
        return { status: 200, json: { ok: true } };
      }
      if (path === "data/list" && method === "GET") {
        const like = (query.prefix || "") + "%";
        const limit = Math.min(1000, Math.max(1, parseInt(query.limit || "1000", 10) || 1000));
        const keysOnly = query.keysOnly === "1";
        // keysOnly skips reading/parsing/sending values — for paging large datasets cheaply.
        if (keysOnly) {
          const rows = query.reverse === "1"
            ? this.sql<{ k: string }>`SELECT k FROM kv WHERE ns = ${ns} AND k LIKE ${like} ORDER BY k DESC LIMIT ${limit}`
            : this.sql<{ k: string }>`SELECT k FROM kv WHERE ns = ${ns} AND k LIKE ${like} ORDER BY k ASC LIMIT ${limit}`;
          return { status: 200, json: { items: rows.map((r) => ({ key: r.k })) } };
        }
        const rows = query.reverse === "1"
          ? this.sql<{ k: string; v: string }>`SELECT k, v FROM kv WHERE ns = ${ns} AND k LIKE ${like} ORDER BY k DESC LIMIT ${limit}`
          : this.sql<{ k: string; v: string }>`SELECT k, v FROM kv WHERE ns = ${ns} AND k LIKE ${like} ORDER BY k ASC LIMIT ${limit}`;
        return { status: 200, json: { items: rows.map((r) => ({ key: r.k, value: JSON.parse(r.v) })) } };
      }
      if (path === "data/count" && method === "GET") {
        const like = (query.prefix || "") + "%";
        const c = this.sql<{ c: number }>`SELECT COUNT(*) AS c FROM kv WHERE ns = ${ns} AND k LIKE ${like}`[0].c;
        return { status: 200, json: { count: c } };
      }
      return { status: 404, json: { error: "not found" } };
    } catch (e) {
      return { status: 500, json: { error: String((e as Error)?.message || e) } };
    }
  }

  private async scheduleReminder(ns: string, b: any): Promise<string> {
    if ((await this.listSchedules()).length >= MAX_REMINDERS) throw new Error("Reminder limit reached (50). Cancel some first.");
    const payload = { ns, title: String(b.title || "Reminder"), body: String(b.body || ""), url: b.url ? String(b.url) : "./" };
    if (b.everyMinutes) {
      const sec = Math.max(60, Math.round(Number(b.everyMinutes) * 60));
      return (await this.scheduleEvery(sec, "fireReminder" as keyof this, payload)).id;
    }
    if (b.dailyAt) {
      // dailyAt is the user's LOCAL time; the SDK sends tzOffset (= JS getTimezoneOffset) so we can
      // target the right UTC cron. (See dailyAtToCron — fixed offset, so ~1h DST drift.)
      const cron = dailyAtToCron(String(b.dailyAt), Number(b.tzOffset));
      return (await this.schedule(cron, "fireReminder" as keyof this, payload)).id;
    }
    if (b.at) {
      const when = typeof b.at === "number" ? new Date(b.at) : new Date(String(b.at));
      return (await this.schedule(when, "fireReminder" as keyof this, payload)).id;
    }
    throw new Error("reminder needs one of: at, everyMinutes, dailyAt");
  }

  private async listReminders(ns: string) {
    const all = await this.listSchedules();
    return all
      .filter((s: any) => s.payload && s.payload.ns === ns)
      .map((s: any) => ({ id: s.id, title: s.payload.title, body: s.payload.body, type: s.type, time: s.time ?? null, cron: s.cron ?? null }));
  }

  // Alarm callback (must be public so this.schedule can invoke it by name).
  async fireReminder(payload: { ns: string; title: string; body: string; url: string }) {
    this.ensure();
    await this.sendToAll(payload.ns, payload);
  }

  private async sendToAll(ns: string, msg: any): Promise<number> {
    const subs = this.sql<{ id: string; endpoint: string; p256dh: string; auth: string }>`SELECT id, endpoint, p256dh, auth FROM subs WHERE ns = ${ns}`;
    let sent = 0;
    for (const s of subs) if (await this.sendOne(s, msg)) sent++;
    return sent;
  }

  private async sendOne(s: { id: string; endpoint: string; p256dh: string; auth: string }, msg: any): Promise<boolean> {
    try {
      const req = await buildPushHTTPRequest({
        privateJWK: this.env.VAPID_PRIVATE_JWK,
        subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        message: {
          payload: { title: String(msg.title || "Reminder").slice(0, 120), body: String(msg.body || "").slice(0, 300), url: msg.url || "./" },
          adminContact: this.env.VAPID_SUBJECT || "mailto:admin@example.com",
          options: { ttl: PUSH_TTL, urgency: "high" },
        },
      });
      const res = await fetch(req.endpoint, { method: "POST", headers: req.headers as HeadersInit, body: req.body });
      if (res.status === 404 || res.status === 410) {
        this.sql`DELETE FROM subs WHERE id = ${s.id}`;
        return false;
      }
      return res.ok;
    } catch {
      return false;
    }
  }
}

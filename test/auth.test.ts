import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { mintAppToken, verifyAppToken, safeNext } from "../src/auth";

const env = ({ PUBLIC_BASE_URL: "https://ship-it-app.com", CAP_SECRET: "cap", COOKIE_SECRET: "cookie" } as unknown) as Env;
const otherEnv = ({ ...({} as any), CAP_SECRET: "different" } as unknown) as Env;

describe("capability tokens", () => {
  it("bind an app id + user and round-trip", async () => {
    const t = await mintAppToken(env, "app1", "user1");
    expect(await verifyAppToken(env, t)).toMatchObject({ a: "app1", u: "user1" });
  });
  it("are rejected under a different CAP_SECRET", async () => {
    const t = await mintAppToken(env, "app1", "user1");
    expect(await verifyAppToken(otherEnv, t)).toBeNull();
  });
  it("carry the app id so the caller can enforce per-app scope", async () => {
    const claims = await verifyAppToken(env, await mintAppToken(env, "appA", "u"));
    expect(claims?.a).toBe("appA"); // index.ts checks claims.a === path id (blocks cross-app reads)
  });
});

describe("safeNext (open-redirect guard)", () => {
  it("allows same-origin paths", () => {
    expect(safeNext(env, "/dashboard")).toBe("/dashboard");
    expect(safeNext(env, "/s/abc/")).toBe("/s/abc/");
  });
  it("allows https URLs within the zone (apex or subdomain)", () => {
    expect(safeNext(env, "https://ship-it-app.com/x")).toBe("https://ship-it-app.com/x");
    expect(safeNext(env, "https://abc123.ship-it-app.com/")).toBe("https://abc123.ship-it-app.com/");
  });
  it("rejects off-site and protocol-relative targets", () => {
    expect(safeNext(env, "https://evil.com")).toBe("/dashboard");
    expect(safeNext(env, "//evil.com")).toBe("/dashboard"); // protocol-relative
    expect(safeNext(env, "/\\evil.com")).toBe("/dashboard"); // backslash variant
    expect(safeNext(env, "http://ship-it-app.com/x")).toBe("/dashboard"); // non-https
    expect(safeNext(env, undefined)).toBe("/dashboard");
  });
});

import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import {
  accountOrigin,
  appUrl,
  appHostId,
  subdomainMode,
  cookieDomainAttr,
  canOpenApp,
  serviceClosedReason,
} from "../src/store";

const env = (base: string, extra: Partial<Env> = {}) => ({ PUBLIC_BASE_URL: base, ...extra }) as unknown as Env;
const CUSTOM = env("https://ship-it-app.com");
const WORKERS = env("https://easy-host.foo.workers.dev");
const LOCAL = env("http://localhost:8799");

describe("subdomainMode", () => {
  it("is on only for a real custom domain", () => {
    expect(subdomainMode(CUSTOM)).toBe(true);
    expect(subdomainMode(WORKERS)).toBe(false);
    expect(subdomainMode(LOCAL)).toBe(false);
    expect(subdomainMode(env("http://127.0.0.1:8799"))).toBe(false);
  });
});

describe("accountOrigin", () => {
  it("strips trailing slashes", () => {
    expect(accountOrigin(env("https://ship-it-app.com/"))).toBe("https://ship-it-app.com");
  });
});

describe("appUrl", () => {
  it("uses a subdomain on a custom domain, path-mode otherwise", () => {
    expect(appUrl(CUSTOM, "abc123")).toBe("https://abc123.ship-it-app.com/");
    expect(appUrl(WORKERS, "abc123")).toBe("https://easy-host.foo.workers.dev/s/abc123/");
    expect(appUrl(LOCAL, "abc123")).toBe("http://localhost:8799/s/abc123/");
  });
});

describe("appHostId", () => {
  it("returns the id only for a single-label app subdomain", () => {
    expect(appHostId(CUSTOM, "abc123.ship-it-app.com")).toBe("abc123");
    expect(appHostId(CUSTOM, "ship-it-app.com")).toBeNull(); // apex
    expect(appHostId(CUSTOM, "www.ship-it-app.com")).toBeNull(); // www
    expect(appHostId(CUSTOM, "a.b.ship-it-app.com")).toBeNull(); // multi-label
    expect(appHostId(CUSTOM, "ABC.ship-it-app.com")).toBeNull(); // uppercase not a valid id
    expect(appHostId(WORKERS, "abc.easy-host.foo.workers.dev")).toBeNull(); // path mode: never
  });
});

describe("cookieDomainAttr", () => {
  it("scopes to the apex on a custom domain, host-only otherwise", () => {
    expect(cookieDomainAttr(CUSTOM)).toBe("; Domain=ship-it-app.com");
    expect(cookieDomainAttr(LOCAL)).toBe("");
  });
});

describe("canOpenApp (sign-in always required)", () => {
  it("blocks anonymous visitors entirely", () => {
    expect(canOpenApp("public", null, "owner")).toBe(false);
    expect(canOpenApp("private", null, "owner")).toBe(false);
  });
  it("public: any signed-in user; private: owner only", () => {
    expect(canOpenApp("public", "anyone", "owner")).toBe(true);
    expect(canOpenApp("private", "owner", "owner")).toBe(true);
    expect(canOpenApp("private", "intruder", "owner")).toBe(false);
    expect(canOpenApp("private", "someone", undefined)).toBe(false); // ownerless private => nobody
  });
});

describe("serviceClosedReason (publishing soft-close)", () => {
  it("closes on SERVICE_OPEN=false and on a past SERVICE_OPEN_UNTIL", () => {
    expect(serviceClosedReason(env("https://x.com", { SERVICE_OPEN: "false" }))).not.toBeNull();
    expect(serviceClosedReason(env("https://x.com", { SERVICE_OPEN_UNTIL: "2000-01-01T00:00:00Z" }))).not.toBeNull();
  });
  it("stays open by default and before the deadline", () => {
    expect(serviceClosedReason(env("https://x.com"))).toBeNull();
    expect(serviceClosedReason(env("https://x.com", { SERVICE_OPEN_UNTIL: "2999-01-01T00:00:00Z" }))).toBeNull();
  });
});

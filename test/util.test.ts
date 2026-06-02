import { describe, it, expect } from "vitest";
import {
  genId,
  sha256hex,
  b64url,
  b64urlStr,
  b64urlToStr,
  timingSafeEqual,
  signToken,
  verifyToken,
  dailyAtToCron,
  hhmmToMin,
  escapeAttr,
  parseCookie,
  safeJson,
} from "../src/util";

const SECRET = "test-secret";

describe("genId", () => {
  it("is 16 lowercase hex chars (DNS-label safe)", () => {
    expect(genId()).toMatch(/^[0-9a-f]{16}$/);
  });
  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => genId()));
    expect(ids.size).toBe(500);
  });
});

describe("base64url", () => {
  it("round-trips ASCII and UTF-8", () => {
    for (const s of ["", "hello", "héllo 🚀 世界", "a/b+c=d"]) {
      expect(b64urlToStr(b64urlStr(s))).toBe(s);
    }
  });
  it("emits url-safe alphabet only (no +/=)", () => {
    const out = b64url(new Uint8Array([251, 255, 254, 0, 1]));
    expect(out).not.toMatch(/[+/=]/);
  });
});

describe("sha256hex", () => {
  it("matches the known vector for 'abc'", async () => {
    expect(await sha256hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("timingSafeEqual", () => {
  it("true for equal, false for different content or length", () => {
    expect(timingSafeEqual("abcdef", "abcdef")).toBe(true);
    expect(timingSafeEqual("abcdef", "abcdeg")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("signToken / verifyToken", () => {
  it("round-trips a payload", async () => {
    const t = await signToken(SECRET, { a: "app1", u: "user1" });
    expect(await verifyToken<{ a: string; u: string }>(SECRET, t)).toMatchObject({ a: "app1", u: "user1" });
  });
  it("rejects a tampered payload", async () => {
    const t = await signToken(SECRET, { a: "app1" });
    const tampered = b64urlStr(JSON.stringify({ a: "app2" })) + "." + t.split(".")[1];
    expect(await verifyToken(SECRET, tampered)).toBeNull();
  });
  it("rejects the wrong secret", async () => {
    const t = await signToken(SECRET, { a: "app1" });
    expect(await verifyToken("other-secret", t)).toBeNull();
  });
  it("rejects an expired token but accepts a future / absent exp", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyToken(SECRET, await signToken(SECRET, { exp: now - 10 }))).toBeNull();
    expect(await verifyToken(SECRET, await signToken(SECRET, { exp: now + 1000 }))).not.toBeNull();
    expect(await verifyToken(SECRET, await signToken(SECRET, { ok: 1 }))).not.toBeNull();
  });
  it("rejects malformed / null tokens", async () => {
    expect(await verifyToken(SECRET, null)).toBeNull();
    expect(await verifyToken(SECRET, "no-dot")).toBeNull();
    expect(await verifyToken(SECRET, "garbage.sig")).toBeNull();
  });
});

describe("dailyAtToCron (local HH:MM + tzOffset -> UTC cron)", () => {
  it("converts across zones, half-hour offsets, and day wrap", () => {
    expect(dailyAtToCron("08:00", -480)).toBe("0 0 * * *"); // UTC+8 (Taiwan) 8am -> midnight UTC
    expect(dailyAtToCron("08:00", 480)).toBe("0 16 * * *"); // UTC-8 (PST) 8am -> 16:00 UTC
    expect(dailyAtToCron("21:00", -330)).toBe("30 15 * * *"); // UTC+5:30 (IST) 9pm -> 15:30 UTC
    expect(dailyAtToCron("02:00", -480)).toBe("0 18 * * *"); // wraps to previous UTC day
  });
  it("treats a missing/NaN offset as UTC", () => {
    expect(dailyAtToCron("08:30", NaN)).toBe("30 8 * * *");
  });
});

describe("hhmmToMin", () => {
  it("converts HH:MM to minutes since midnight", () => {
    expect(hhmmToMin("00:00")).toBe(0);
    expect(hhmmToMin("08:30")).toBe(510);
    expect(hhmmToMin("23:59")).toBe(1439);
  });
});

describe("escapeAttr", () => {
  it("escapes the HTML-significant chars", () => {
    expect(escapeAttr(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});

describe("parseCookie", () => {
  it("extracts a named cookie and decodes it", () => {
    expect(parseCookie("a=1; eh_session=ab%20c; b=2", "eh_session")).toBe("ab c");
    expect(parseCookie("a=1", "missing")).toBeNull();
    expect(parseCookie(null, "x")).toBeNull();
  });
});

describe("safeJson", () => {
  it("escapes < to stay safe inside <script>", () => {
    expect(safeJson({ x: "</script>" })).not.toContain("</script>");
  });
});

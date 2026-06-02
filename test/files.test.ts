import { describe, it, expect } from "vitest";
import type { Site } from "../src/types";
import {
  normalizeFilePath,
  requestToFileKey,
  contentTypeFor,
  isReservedAppPath,
  sanitizeFiles,
  mergeFiles,
  siteFiles,
  ENTRY,
} from "../src/files";

describe("normalizeFilePath", () => {
  it("accepts clean relative paths", () => {
    expect(normalizeFilePath("index.html")).toBe("index.html");
    expect(normalizeFilePath("app.js")).toBe("app.js");
    expect(normalizeFilePath("screens/chat.js")).toBe("screens/chat.js");
    expect(normalizeFilePath("/app.js")).toBe("app.js"); // leading slash stripped
  });
  it("rejects traversal / unsafe paths", () => {
    for (const bad of ["..", "../x", "a/../b", "a//b", "a\\b", "x y", "a\0b", "", "dir/", "a*b", "a;b"]) {
      expect(normalizeFilePath(bad)).toBeNull();
    }
    expect(normalizeFilePath("a".repeat(300))).toBeNull(); // too long
  });
});

describe("requestToFileKey", () => {
  it("maps request paths to file keys", () => {
    expect(requestToFileKey("/")).toBe("index.html");
    expect(requestToFileKey("/app.js")).toBe("app.js");
    expect(requestToFileKey("/chat/")).toBe("chat/index.html");
    expect(requestToFileKey("/chat/123")).toBe("chat/123"); // SPA route -> falls back to index.html upstream
  });
  it("blocks traversal", () => {
    expect(requestToFileKey("/../etc/passwd")).toBeNull();
    expect(requestToFileKey("/a/../b")).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("maps extensions, never defaults to text/html", () => {
    expect(contentTypeFor("x.js")).toMatch(/text\/javascript/);
    expect(contentTypeFor("x.mjs")).toMatch(/text\/javascript/);
    expect(contentTypeFor("x.css")).toMatch(/text\/css/);
    expect(contentTypeFor("x.html")).toMatch(/text\/html/);
    expect(contentTypeFor("x.svg")).toMatch(/image\/svg/);
    expect(contentTypeFor("x.png")).toBe("text/plain;charset=utf-8"); // unknown -> text/plain
    expect(contentTypeFor("noext")).toBe("text/plain;charset=utf-8");
  });
});

describe("isReservedAppPath", () => {
  it("flags our endpoints, not app files", () => {
    for (const r of ["sw.js", "sdk.js", "manifest.webmanifest", "robots.txt", "icon-192.png", "api", "api/data"]) {
      expect(isReservedAppPath(r)).toBe(true);
    }
    for (const ok of ["index.html", "app.js", "styles.css", "screens/chat.js", ""]) {
      expect(isReservedAppPath(ok)).toBe(false);
    }
  });
});

describe("sanitizeFiles", () => {
  it("accepts a valid multi-file app", () => {
    const r = sanitizeFiles({ "index.html": "<!doctype html>", "app.js": "console.log(1)", "styles.css": "body{}" });
    expect(r.error).toBeUndefined();
    expect(Object.keys(r.files!)).toEqual(["index.html", "app.js", "styles.css"]);
  });
  it("requires index.html", () => {
    expect(sanitizeFiles({ "app.js": "x" }).error).toMatch(/index\.html/);
    expect(sanitizeFiles({}).error).toBeTruthy();
  });
  it("rejects reserved paths, bad extensions, traversal, and non-text", () => {
    expect(sanitizeFiles({ "index.html": "x", "sw.js": "y" }).error).toMatch(/reserved/);
    expect(sanitizeFiles({ "index.html": "x", "logo.png": "y" }).error).toMatch(/unsupported/);
    expect(sanitizeFiles({ "index.html": "x", "../escape.js": "y" }).error).toMatch(/invalid file path/);
    expect(sanitizeFiles({ "index.html": "x", "bad.js": 5 as unknown as string }).error).toMatch(/must be text/);
  });
  it("enforces total-size and file-count caps", () => {
    expect(sanitizeFiles({ "index.html": "x".repeat(2_000_001) }).error).toMatch(/too large/);
    const many: Record<string, string> = { "index.html": "x" };
    for (let i = 0; i < 25; i++) many[`f${i}.js`] = "x";
    expect(sanitizeFiles(many).error).toMatch(/too many files/);
  });
});

describe("mergeFiles", () => {
  it("upserts changed files and removes others (never index.html)", () => {
    const existing = { "index.html": "v1", "app.js": "a1", "old.css": "c" };
    const merged = mergeFiles(existing, { "app.js": "a2", "new.js": "n" }, ["old.css", "index.html"]);
    expect(merged).toEqual({ "index.html": "v1", "app.js": "a2", "new.js": "n" }); // index.html survives removal attempt
  });
});

describe("siteFiles", () => {
  it("treats a single-file html site as { index.html }", () => {
    expect(siteFiles({ html: "<p>hi</p>" } as Site)).toEqual({ [ENTRY]: "<p>hi</p>" });
  });
  it("returns the files map when present", () => {
    const files = { "index.html": "x", "app.js": "y" };
    expect(siteFiles({ files } as Site)).toBe(files);
  });
});

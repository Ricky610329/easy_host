// Multi-file app helpers: path normalization (security-critical), content-types, reserved-path
// detection, and resolving a Site to its files map. All pure + heavily unit-tested.
import type { Site } from "./types";

export const ENTRY = "index.html";
export const MAX_FILES = 20;
export const MAX_TOTAL_BYTES = 2_000_000;

// Content-types we serve. The extension whitelist for stored files is exactly these keys.
const TYPES: Record<string, string> = {
  html: "text/html;charset=utf-8",
  js: "text/javascript;charset=utf-8",
  mjs: "text/javascript;charset=utf-8",
  css: "text/css;charset=utf-8",
  json: "application/json;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  txt: "text/plain;charset=utf-8",
};
export const ALLOWED_EXT = new Set(Object.keys(TYPES));

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}
export function contentTypeFor(path: string): string {
  return TYPES[extOf(path)] || "text/plain;charset=utf-8"; // never default to text/html
}

// Paths we serve ourselves on an app subdomain; an app file at one of these would be shadowed.
const RESERVED = new Set(["sw.js", "sdk.js", "manifest.webmanifest", "robots.txt", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]);
export function isReservedAppPath(path: string): boolean {
  return path === "" || path === ENTRY ? false : RESERVED.has(path) || path === "api" || path.startsWith("api/");
}

// Normalize a stored file key: strip leading slashes; reject traversal / unsafe / non-concrete paths.
// Returns null if unsafe. (Concrete files only — no empty, no trailing-slash directories.)
export function normalizeFilePath(path: string): string | null {
  const p = String(path).replace(/^\/+/, "");
  if (!p || p.endsWith("/")) return null;
  if (p.includes("..") || p.includes("\\") || p.includes("\0") || p.includes("//")) return null;
  if (p.length > 256) return null;
  if (!/^[A-Za-z0-9._\-/]+$/.test(p)) return null;
  return p;
}

// Map an incoming request sub-path to a files-map key (or null if unsafe). "/" or "/dir/" -> .../index.html.
export function requestToFileKey(sub: string): string | null {
  let p = String(sub).replace(/^\/+/, "");
  if (p === "" || p.endsWith("/")) p += ENTRY;
  return normalizeFilePath(p);
}

// The files map for a site (single-file html is sugar for { "index.html": html }).
export function siteFiles(site: Site): Record<string, string> {
  if (site.files && Object.keys(site.files).length) return site.files;
  return { [ENTRY]: site.html || "" };
}

// Validate + normalize a files map (keys are rewritten to their normalized form). Returns one or the other.
export function sanitizeFiles(files: Record<string, unknown>): { files?: Record<string, string>; error?: string } {
  const out: Record<string, string> = {};
  let total = 0;
  let count = 0;
  for (const [rawK, v] of Object.entries(files)) {
    if (typeof v !== "string") return { error: `file "${rawK}" must be text` };
    const k = normalizeFilePath(rawK);
    if (!k) return { error: `invalid file path: "${rawK}"` };
    if (isReservedAppPath(k)) return { error: `"${k}" is a reserved path` };
    if (!ALLOWED_EXT.has(extOf(k))) return { error: `unsupported file type: "${k}" (allowed: ${[...ALLOWED_EXT].join(", ")})` };
    if (out[k] !== undefined) return { error: `duplicate path: "${k}"` };
    out[k] = v;
    total += v.length;
    count++;
  }
  if (count > MAX_FILES) return { error: `too many files (max ${MAX_FILES})` };
  if (!out[ENTRY] || !out[ENTRY].trim()) return { error: `${ENTRY} is required` };
  if (total > MAX_TOTAL_BYTES) return { error: "app too large (max ~2 MB total)" };
  return { files: out };
}

// Merge a patch into an existing files map for update_app (upsert + optional removals; never drops index.html).
export function mergeFiles(existing: Record<string, string>, patch?: Record<string, string>, remove?: string[]): Record<string, string> {
  const out = { ...existing };
  if (patch) for (const [k, v] of Object.entries(patch)) out[k] = v;
  if (remove) for (const k of remove) if (k !== ENTRY) delete out[normalizeFilePath(k) || k];
  return out;
}

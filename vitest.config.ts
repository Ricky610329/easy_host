import { defineConfig } from "vitest/config";

// Pure/crypto helpers run under Node (Web Crypto, btoa/atob, TextEncoder are all globals on Node 20+).
// We only test env-free logic in util.ts / store.ts / auth.ts — not the Worker/DO runtime.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});

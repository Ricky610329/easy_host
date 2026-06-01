// Generate a VAPID (Web Push) key pair for easy_host.
//
//   node scripts/gen-vapid.mjs
//
// Then set the three secrets (or paste them into .dev.vars for local dev):
//   echo -n '<VAPID_PUBLIC_KEY>'  | npx wrangler secret put VAPID_PUBLIC_KEY
//   echo -n '<VAPID_PRIVATE_JWK>' | npx wrangler secret put VAPID_PRIVATE_JWK
//   echo -n 'mailto:you@example.com' | npx wrangler secret put VAPID_SUBJECT
//
// VAPID_PUBLIC_KEY  is the raw P-256 public key (base64url) handed to browsers.
// VAPID_PRIVATE_JWK is the private key as a JWK (JSON string) used to sign the VAPID JWT.

import { webcrypto as crypto } from "node:crypto";

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const publicKey = Buffer.from(rawPub).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log("VAPID_PUBLIC_KEY=" + publicKey);
console.log("VAPID_PRIVATE_JWK=" + JSON.stringify(privateJwk));
console.log("VAPID_SUBJECT=mailto:you@example.com");

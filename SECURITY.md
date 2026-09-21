# Access and data handling

## Intended scope

Small, private assignment review. Anyone who receives the shared code can access the historical extract and PDF. This is not individual-user identity or a production fleet system. An authorised viewer can copy the data; entry-code protection cannot prevent that.

## Controls

- Code verification happens on the server before the private HTML or PDF is read or sent. No code or signing secret is included in browser assets or Git.
- A randomly generated entry code has at least 128 bits of entropy. Its SHA-256 digest and a separate signing secret are runtime-only sensitive Vercel variables.
- Signed, host-bound sessions expire after one hour; the cookie is Secure, HttpOnly, SameSite=Strict and host-only.
- Same-origin checks apply to login/logout. Request bodies and accepted routes are bounded. Unknown paths never expose files.
- Private responses use no-store caching. Script CSP uses exact hashes; framing, MIME sniffing, referrer disclosure and unnecessary browser permissions are restricted. Inline styles remain allowed for the existing UI; inline script event handlers are not.
- The build has no public static files. The dataset and PDF reside in a private serverless-function bundle. Source remains in a private repository.
- No analytics or third-party application requests. The app checks its own session endpoint. Hosting infrastructure can retain normal request metadata; the app does not log entry codes, cookies or form bodies.
- Failed-login throttling is bounded and best-effort per function instance. It is not a durable, distributed rate limiter. High-entropy codes are required; short PINs are unsuitable. Vercel's platform protections add another layer but are not a substitute for application checks.

## Browser notes and sign-out

Action notes are in localStorage, not encrypted or shared. Expiry, timeouts and network failures lock the screen and preserve saved notes; unsaved drafts may be lost. The locked screen requires an explicit reopen, avoiding a reload loop during an outage. Use a trusted browser/device. Sign-out clears the app's local notes and cookie; response headers also request browser cache/storage clearing where supported. A copied session token remains valid until its one-hour expiry or a signing-key/version rotation; there is no per-token revocation list. Other already-open tabs check the session on focus and at most every 60 seconds. A page already delivered cannot be remotely erased, and downloaded copies remain with the reviewer.

## Rotate or end access

Generate a new high-entropy code, update its hash and the session signing secret/version, then redeploy. Protect or remove all old deployment URLs; old deployments retain their prior runtime values. Do not share bypass links or Vercel automation tokens. When the exercise ends, revoke access and remove exercise copies and backups according to the agreed retention requirement. No automatic deletion is performed by this app.

## Limits and future work

There is no user roster, per-person revocation, durable audit log, database, shared task delivery, live telemetry or operational role enforcement. The proposed decision rights in the case brief remain subject to signed approval. For ongoing operational use, replace the shared code with individual authentication, managed authorization, durable rate limits and audited shared records.

Report a concern privately to the repository owner. Do not open a public issue containing exercise data or credentials.

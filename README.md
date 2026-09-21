# Fleet decision review

Private assignment prototype. This repository contains the supplied exercise extract and must remain private.

**Live prototype:** https://fleet-decision-review.vercel.app/

**Private source:** https://github.com/AyushAg1002/fleet-decision-review

## What the reviewer can do

Enter the access code supplied separately by the owner. Choose a managed-service (O) or client-operated (S) group, inspect supporting trip records, prepare a decision brief, and record a local action with an owner, deadline and closure evidence. The app's **What does what?** guide explains each control. **Two-page brief** opens the standards, decisions not built, and pilot success measures behind the same access check.

Actions are saved in that browser only. Session expiry or a failed access check locks the view but preserves saved notes; unsaved drafts may be lost. They are not shared assignments or notifications. Export a backup before signing out if it is needed; sign-out clears this app's notes on the current browser. Downloads remain on the device. Historical lateness is plan adherence, not a verified contract breach or established cause.

## Run and build

Node.js 22 is the only runtime dependency. There are no application packages to install.

```sh
npm test
npm run build
```

The build writes one Vercel Node function under `.vercel/output/functions/gateway.func/`. Its private HTML and PDF live inside the function bundle; `.vercel/output/static/` is empty. All URL paths route through the handler's allowlist and authentication check. Do not move the HTML, PDF or dataset into a public/static directory or enable GitHub Pages.

## Deploy to Vercel

Use the existing project. Configure these sensitive runtime environment variables before production deployment:

- `DEMO_ACCESS_CODE_HASH`: lowercase SHA-256 of the high-entropy entry code; the plaintext code is not in this repository.
- `DEMO_SESSION_SECRET`: at least 32 random bytes, encoded as hex.
- `DEMO_ACCESS_VERSION`: a new version string when access is revoked or rotated.

Run `npm test`, `npm run build`, then `vercel deploy --prebuilt --prod`. A normal Vercel source build can also run `node build.mjs`. A deployment without valid runtime configuration fails closed.

Share the live URL and entry code privately. Do not put the code in a URL, commit, issue, README or screenshot. To revoke access, change the code hash, signing secret and access version, and redeploy. Protect or remove older deployments as well; changing the current deployment does not change secrets already captured by an older deployment.

## File map

| File | Purpose |
| --- | --- |
| `core.js` | Timing rules, group summaries, recommended checks, authority wording and action validation. |
| `app.js` | Queue, evidence dialogs, decision briefs and browser-local action workflow. |
| `shell.html`, `styles.css` | Page layout and reviewer guide. |
| `session.js` | Checks session validity and clears the view on expiry/sign-out. |
| `data.json` | Verified original-data extract; private exercise material. |
| `brief.pdf` | Two-page assignment brief; served only after authentication. |
| `server.cjs` | Server-side entry-code verification, signed session, route allowlist and response headers. |
| `build.mjs` | Reproducible private function bundle; no public static data. |
| `server.test.cjs`, `session.test.cjs`, `app.test.cjs` | Server authentication, client session, original-data and rule-validation regression tests. |
| `SECURITY.md` | Protections, limits and access-revocation procedure. |

The deployment adds an access boundary to the reviewed prototype. It does not implement live dispatch, document verification, spending authority, shared operations or production identity management.

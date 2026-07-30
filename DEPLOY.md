# Salon Vine App — Deploy Guide

Multi-tenant staff portal + signup/lead/photo proxies for **salonvine-app.netlify.app**
(Netlify team `zackbrockway17`, site name `salonvine-app`).

All salon data lives in one Netlify Blobs store (`sv-data`, strong consistency),
hard-partitioned by key prefix `s/<slug>/...`. Every request re-checks that the
session JWT's `slug` matches the salon being touched.

---

## 1. Environment variables (Site settings → Environment variables)

| Name | Value / notes |
|---|---|
| `JWT_SECRET` | Long random string (e.g. `openssl rand -hex 48`). Rotating it signs everyone out. |
| `SV_EXEC` | `https://script.google.com/macros/s/AKfycbyXCmFCL-HuLEFvZDTsV9fIrYiaRCW06ZuNl1uYR-4DhgaJpmthlUKaAIr8rtau2_g4/exec` |
| `SV_TOKEN` | Full Apps Script token — used only for the mail/SMS relay (`type:'sendMail'`). |
| `SV_SIGNUP_TOKEN` | Public-write Apps Script token — used server-side for `signupSite` / `sitePhoto` / `siteLead`. |
| `FOUNDER_ALERT_EMAILS` | `ai@zbrockmotors.com,zackbrockway17@gmail.com,halleroffroadllc@gmail.com` |

No token ever appears in client code; the browser only ever talks to `/api/*`.

Requires the **backend v4** Apps Script deployment (adds `type:'sendMail'` and
`plan` in the public `?site=` payload). If `plan` is missing from the registry,
the app defaults that salon to `studio` (3 seats) — it never gives seats away.

## 2. Deploy

```bash
cd salonvine-app
netlify deploy --prod --site salonvine-app
# or: connect the repo to the salonvine-app site and push
```

- `package.json` lists `@netlify/blobs` — Netlify installs it at build time; do
  not commit `node_modules`.
- Functions dir: `netlify/functions`. Publish dir: `.` (repo root).
- Blobs store `sv-data` is created automatically on first write — nothing to
  provision.

## 3. URL scheme

| URL | What it is |
|---|---|
| `/p/<slug>` | Salon's staff portal (login → app) |
| `/p/<slug>/welcome?invite=CODE&email=...` | One-time invite activation (owner + stylists) |
| `/p/<slug>/reset?code=CODE&email=...` | One-time password reset (1-hour code) |
| `/p/<slug>/reset` | Request-a-reset form |
| `/api/*` | Functions (JSON). CORS-allowed origins: salonvine.com, www.salonvine.com, salonvine-app.netlify.app |
| `/` | 302 → salonvine.com |

These are 200 rewrites; the client parses slug/view from the path.

## 4. Endpoints (all under `/api/`)

| Endpoint | Auth | Notes |
|---|---|---|
| `signup-proxy` POST | none (CORS) | `{salon,name,email,phone,website,plan}` → registers salon, creates inactive owner account, relays invite email+text, alerts founders. Returns `{ok,slug,url}`. |
| `site-photo-proxy` POST | none | `{slug,n,data}` → forwards `sitePhoto` with token. |
| `site-lead-proxy` POST | none | `{slug,name,phone,email,message}` → forwards `siteLead`. |
| `salon-config` GET `?slug=` | none | Public-safe chrome config: name, accent, plan, seatLimit. 5-min server cache. |
| `login` POST | — | `{slug,email,password}` → sets `sv_session` cookie (90 days). |
| `logout` POST | — | Clears cookie. |
| `me` GET | cookie | Session `{slug,email,role,name}` or 401. |
| `set-password` POST | code | `{slug,email,invite,password}` — accepts an invite code **or** a reset code; single-use; signs in on success. |
| `forgot-password` POST | — | Always `{ok:true}`; if the account exists, stores a 1-hour code and emails the reset link. |
| `stylists` GET/POST | admin | List / add / `action:'remove'` / `action:'resend'`. Add enforces seat limits (studio 3 / pro 10 / elite unlimited; owner counts). Over-limit adds get a clear 409; removal frees the seat instantly. |
| `bookings` GET `?slug=` | staff | Admin sees all; stylist sees hers + "first available" (`?scope=all` for read-only team view). |
| `booking-status` POST | staff | `{slug,id,status}` — admin or the assigned stylist; `status:'delete'` is admin-only. |
| `manifest` GET `?slug=` | none | Per-salon PWA manifest (salon name + accent). |

## 5. Test checklist (after env vars are set)

1. **Signup:** POST `/api/signup-proxy` from salonvine.com signup page →
   `{ok,slug,url}`; owner receives "set up your portal" email (and text);
   founders each get an alert email.
2. **Owner activation:** open the emailed `/p/<slug>/welcome?...` link, set a
   password → lands signed-in in the portal, "Manage Team" tab visible.
3. **Branding:** portal header shows the salon's name; accent color matches the
   salon's registry accent.
4. **Invite a stylist:** Manage Team → add name/email/cell → seat bar ticks up,
   stylist gets email + text; her link activates her account; she does NOT see
   Manage Team.
5. **Seat limit:** on a studio salon add stylists until 3 of 3 used → 4th add
   returns the friendly 409 and the UI surfaces it. Remove one → add succeeds.
6. **Cross-tenant wall:** while logged into salon A, call
   `/api/bookings?slug=<salonB>` → 403. (This is the big one — retest after any
   function change.)
7. **Bookings:** seed a booking under `s/<slug>/bookings/<id>`, confirm the
   stylist filter, Confirm/Done/Cancel, and that Delete is admin-only.
8. **Forgot password:** request reset for a real account → email arrives, link
   sets a new password and signs in; the same link 403s on second use; a bogus
   email still returns "on its way" with no email sent.
9. **Install prompts:** iPhone Safari shows the Share → Add to Home Screen
   walkthrough; Android Chrome shows the one-tap Install button (needs the
   manifest + sw.js, both included). Installed app opens at `/p/<slug>`.
10. **CORS:** OPTIONS preflight from `https://salonvine.com` on any endpoint →
    204 with matching `Access-Control-Allow-Origin`; an unknown origin never
    gets itself echoed back.
11. **Cookie longevity:** log in, reopen the installed app days later — still
    signed in (90-day HttpOnly cookie).

## 6. Data model (store `sv-data`)

```
s/<slug>/users/<email>   {email,name,role:'admin'|'stylist',phone,salt,hash,active,inviteCode?,createdAt}
s/<slug>/bookings/<id>   {id,ts,name,phone,email,service,stylist,when,status}
s/<slug>/resets/<code>   {email,exp}
```

Passwords: PBKDF2-SHA512, 100k iterations, per-user salt. Sessions: HMAC-SHA256
JWT (`{slug,email,role,name,exp}`) in the `sv_session` HttpOnly/Secure/Lax
cookie. Nothing secret is ever written to a blob in plaintext.

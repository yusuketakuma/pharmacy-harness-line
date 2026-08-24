# Admin Authentication (tenant password session + CSRF)

The admin dashboard uses the pharmacy code, staff login ID, and password. The
retired browser API-key login is not supported. A successful login creates an
opaque **HttpOnly session cookie** bound to exactly one tenant.

## How it works

1. **Login** — `POST /api/auth/login { pharmacyCode, loginId, password }`. The
   Worker validates an active tenant, credential, staff member, and membership,
   then sets three cookies:
   - `lh_admin_session` — the credential. **HttpOnly**, `Secure`, `Path=/`,
     `Max-Age=604800`. It contains only an opaque session token.
   - `lh_tenant` — the tenant binding. **HttpOnly** and checked against the
     session record on every request.
   - `lh_csrf` — a random CSRF token. Readable, `Secure`. Also returned in the
     response body.
2. **Authenticated requests** — the browser sends `lh_admin_session`
   automatically (`credentials: 'include'`). For state-changing requests
   (`POST/PUT/PATCH/DELETE`) the SPA also sends the CSRF token in the
   `X-CSRF-Token` header; the Worker rejects the request (`403`) unless that
   header matches the `lh_csrf` cookie (double-submit).
3. **Session check** — `GET /api/auth/session` returns the staff identity and
   the current CSRF token (minting one if missing), letting the SPA recover the
   token after a reload without re-login.
4. **Logout** — `POST /api/auth/logout` expires both cookies.

### Why the CSRF token is also returned in the body

In the default cross-site topology the admin (`*.pages.dev`) and the API
(`*.workers.dev`) are on different registrable domains. The `lh_csrf` cookie
belongs to the API's domain, so the SPA's JavaScript on the admin domain
**cannot read it**. The token is therefore delivered in the login/session
response body and cached client-side; the Worker still validates it against its
own cookie, which the browser does send back (`SameSite=None`).

### Integration Bearer tokens are separate

SDK and MCP callers may still send `Authorization: Bearer <key>` with an
explicit `X-Tenant-Id`. This is API integration authentication, not an alternate
dashboard login. A browser API key is never accepted as a session cookie or by
`POST /api/auth/login`.

### Legacy env-owner tenant bypass (`LEGACY_ENV_OWNER_BYPASS`)

Normally, resolving a tenant via `X-Tenant-Id` still requires an active
`tenant_staff_memberships` row for the caller — the header selects a tenant,
but membership remains the authority. Setting `LEGACY_ENV_OWNER_BYPASS=true`
lets the env-owner identity (a Bearer call authenticated via `API_KEY`) select
a tenant without that membership row, for backward compatibility with
installs predating per-tenant staff membership.

- **When it's used**: only for `staff.id === 'env-owner'` (the `API_KEY`
  fallback identity) targeting a tenant with `pharmacy_mode !== 1` — i.e. a
  tenant with no LINE account ever mapped to it. It is structurally inert for
  any pharmacy-mode tenant, which always falls through to the normal
  membership check.
- **How to observe usage**: every request that takes this path logs
  `accept_via=LEGACY_ENV_OWNER_BYPASS tenant=<id>`. Grep Worker logs for
  `accept_via=LEGACY_ENV_OWNER_BYPASS` to confirm whether it is still
  exercised in production.
- **Retirement condition**: safe to unset once zero occurrences are observed
  over a full billing/audit cycle, matching the same retirement bar used for
  `LEGACY_API_KEY` (see `apps/worker/src/middleware/auth.ts`).

## Topology & configuration

Cookies only reach the API if `SameSite` matches the topology. The Worker reads
three environment variables (see
`apps/worker/src/middleware/admin-auth-config.ts`):

| Variable | Purpose |
|----------|---------|
| `ADMIN_ORIGIN` | Comma-separated allowlist of admin origins for credentialed CORS. No trailing slash. |
| `ADMIN_ALLOW_CROSS_SITE` | `true` → issue `SameSite=None; Secure` cookies (required when admin and API are cross-site). |
| `ADMIN_COOKIE_SAMESITE` | Optional explicit override: `Strict` \| `Lax` \| `None`. |

### Two supported deployments

**(a) Cross-site Pages ↔ Workers (default).** Set
`ADMIN_ORIGIN=https://<admin>.pages.dev` and `ADMIN_ALLOW_CROSS_SITE=true`.
`create-line-harness` does this automatically after deploying the admin.
Cookies are `SameSite=None; Secure`; CSRF protects mutations; CORS is locked to
the allowlist.

Cloudflare Pages also prints per-deployment preview URLs such as
`https://<hash>.<admin>.pages.dev`. Those preview origins are treated as the
same admin Pages project, so clicking Wrangler's fresh deployment URL does not
cause a login-time CORS failure.

> ⚠️ Browsers are phasing out third-party cookies (Safari ITP blocks them
> outright). For long-term robustness prefer option (b).

**(b) Same-site custom domains (recommended).** Serve the admin and API under
one registrable domain — e.g. `admin.example.com` (Pages custom domain) and
`api.example.com` (Worker route). Set `ADMIN_ORIGIN=https://admin.example.com`
and leave `ADMIN_ALLOW_CROSS_SITE` unset; cookies use `SameSite=Lax` and no
third-party-cookie restrictions apply.

### Topology guard

If the admin is cross-site to the API but `SameSite` is not `None` (e.g. the old
`SameSite=Strict`, or a custom domain misconfiguration), `POST /api/auth/login`
**refuses with a 500 and an actionable error** rather than silently issuing a
cookie the browser will drop. This converts the "login breaks after deploy"
failure mode into a clear configuration error.

## Platform admin and data-protection operations (v0.32.0)

Platform admin uses its separate `platform-admin` session and CSRF middleware;
tenant staff sessions and integration Bearer keys are not authorities for
`/api/platform-admin/*`. The default dashboard、tenant list、logs、audit are
PHI-free. Patient list/detail still require a purpose-bound support grant with
reason、ticket、current-password step-up、expiry、constant banner and explicit end.

The recovery workflow is mounted only after `platformAdminAuthMiddleware`:

| Step | Authority and stop condition |
| --- | --- |
| `POST /data-protection/recovery-operations` | Authenticated requester; exact tenant/account mapping; environment is fixed to the current Worker binding; spoofed identity fields are rejected |
| `POST .../:id/preflight` | Verified backup generation、schema/field inventory、counts、coverage/row digest、stop/rollback policy must match; drift is `BLOCKED` before mutation |
| `POST .../:id/approve` | Authenticated Platform admin principal; approval is one-time and expires |
| `POST .../:id/execute` | A different authenticated principal claims the operation; execution ID and active fence bind every batch and same-principal resume |
| `GET .../:id` | PHI-free state/readiness only; no payload、secret、ciphertext、patient/friend ID |

Legacy integration Bearer authentication cannot authorize a write through this
workflow. `dryRun=false`、verified preflight、named approval、separate executor、
active fenceが揃わない mutation は拒否する。`restore_rehearsal`はproduction
routeから実行せず、no-send isolated runnerだけで検証する。production scrub、
delete、restore、secret投入、deployはそれぞれ別Human Gateである。

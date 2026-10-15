# Run Savory locally and deploy with Coolify

Savory stores application data in local SQLite. Menu, orders, profiles, carts,
settings, reservations, promotions, staff, roles, and notifications use the Express
backend. Firebase remains the Google sign-in provider. Application reads and writes
no longer use Firestore or Google Application Default Credentials.

Use **Node.js 24**. The Dockerfile also uses Node 24, which includes the SQLite
runtime without a separate database service.

## Local development

Keep your project-root `.env`, Firebase public configuration, Chapa secret key,
and matching webhook secret. Optionally set the database location:

```dotenv
DATABASE_PATH=data/savory.sqlite
```

Relative paths resolve against the project root (`APP_ROOT` when supplied).
The default is `data/savory.sqlite`. The database and backups are ignored by Git
and excluded from the Docker image.

From the project root:

```powershell
npm --prefix frontend ci
npm --prefix backend ci
npm run dev
```

Open `http://localhost:3000/`. Express and Vite run together on port 3000, even if
`.env` contains `NODE_ENV=production`. A Cloudflare tunnel continues forwarding to
`http://localhost:3000`.

On the first startup, existing `data/db.json` records are imported into the empty
SQLite database. The source JSON is retained. Historical orders without a user ID
remain staff-only; they are never assigned to the next user who signs in.

Service-account JSON, `FIREBASE_SERVICE_ACCOUNT_BASE64`, and
`GOOGLE_APPLICATION_CREDENTIALS` are not needed for application data or normal
Firebase ID-token verification. Keep `FIREBASE_PROJECT_ID` or
`VITE_FIREBASE_PROJECT_ID` configured and matching the sign-in project.
Google sign-in and Chapa still need an internet connection.

## Primary admin setup

Set the primary admin's Google account email in the project-root `.env`:

```dotenv
PRIMARY_ADMIN_EMAIL=your-google-account@example.com
```

The backend synchronizes this account into the local database on startup with
active admin access. Google sign-in with the specified account is still required;
the environment variable does not bypass authentication. An empty database never
grants the first signed-in customer admin access.

To change the primary admin, update `PRIMARY_ADMIN_EMAIL` and restart the backend
(stop and restart `npm run dev` locally, or restart the application in Coolify).
Startup revokes the previous account managed by this variable and grants the new
account. Ordinary staff and additional admins remain in the database and can be
managed through Team Management. The primary account is labeled in that screen
and cannot be edited or removed there.

The optional `npm run db:owner -- your-google-account@example.com` command creates
a separate database-managed admin record. It does not promote an existing
non-admin record or reactivate a disabled account. Use `PRIMARY_ADMIN_EMAIL` for
the primary account you want to change through configuration.

## Database commands and backups

```powershell
npm run db:status
npm run db:export -- data/backup-2026-10-11.json
npm run db:import -- data/restore.json
```

`db:status` prints collection counts only. Exports write to the named JSON file,
without printing document contents or credentials. Existing files are not
overwritten: choose a new filename for each backup. Exports contain private
business/customer records; store them securely outside Git.

Imports accept exported document records, a document-record array, an export with
`collections`, or legacy collection arrays with string `id` fields. Imports are
atomic and create-only. A duplicate or invalid document fails the whole import
without changing existing data. Restore a full backup by stopping the app,
preserving the existing database, configuring a new empty `DATABASE_PATH`, and
importing. Do not delete the current database to test a restore.

JSON exports can be made while the app is running. For a raw SQLite filesystem
backup, stop the app before copying its database and any `-wal`/`-shm` files;
copying only the main database file during writes can miss recent records.

```powershell
npm run lint
npm test
npm run build
```

The build emits `frontend/dist`, `backend/server.js`, and `backend/db-cli.js`.
Production containers use the compiled CLI directly.

## Coolify application settings

1. Create an application with the **Dockerfile** build pack.
2. Set Dockerfile path `/Dockerfile` and build context `/`.
3. Expose container port `3000`; Express binds to `0.0.0.0`.
4. Set `/health` as liveness check. Inspect `/ready` before testing checkout.
5. Attach persistent storage mounted at **`/app/data`** before first deployment.
6. Run **one application replica**. This SQLite database uses a local volume;
   separate replicas must not maintain different copies of business data.
7. Assign a permanent HTTPS domain and set `APP_URL` to that origin.

The production process now refuses a missing or non-HTTPS `APP_URL`. Runtime
variables take precedence over `.env`; configuration changes require a full
backend restart. Redirects and Chapa callback URLs use this configured origin,
never an incoming Host or Forwarded header.

The runtime container runs as the unprivileged `node` user (UID/GID 1000).
Its `/app/data` volume must be writable by that user. For a host bind mount,
set ownership on that specific application data directory to `1000:1000` before
starting the container. Keep the database directory private. Do not expose port
3000 directly to the internet; route public traffic through Coolify's HTTPS proxy.

If client IP limits should distinguish customers, set `TRUST_PROXY_CIDRS` to
the actual Coolify proxy IP or subnet after inspecting its network, for example
`172.18.0.0/16` when that is the real proxy subnet. Leave it empty to trust no
forwarded IPs. Do not set it to `true`, an arbitrary hop count, or a broad public
range. Without trusted proxy configuration, limits group requests by the proxy IP.

The volume preserves data across rebuilds/redeployments. The container defaults to
`/app/data/savory.sqlite`. Do not place the database in the temporary container
layer or bake it into the image. Back up the volume and test restoring exports.
In Coolify, add the volume under Configuration → Persistent Storage, with
Destination Path `/app/data`. See the [Coolify storage guide](https://coolify.io/docs/core/persistent-storage/storage-mounts/overview).

## Runtime variables

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `APP_URL` | Permanent HTTPS origin, without a path |
| `APP_ROOT` | `/app` (set by Dockerfile) |
| `DATABASE_PATH` | `/app/data/savory.sqlite` (set by Dockerfile) |
| `FIREBASE_PROJECT_ID` | Existing Firebase sign-in project ID |
| `PRIMARY_ADMIN_EMAIL` | Verified Google account email for the primary admin |
| `CHAPA_SECRET_KEY` | Existing key for the selected Test or Live mode |
| `CHAPA_WEBHOOK_SECRET` | Exact webhook secret from the matching dashboard mode |
| `TRUST_PROXY_CIDRS` | Actual trusted proxy IP/subnet; empty trusts no forwarded client IPs |

Keep secrets outside Git and Docker build arguments. Optional Mailchimp/Shipday
integrations retain their existing runtime variables. A Firebase service account
is not needed for this SQLite deployment.

## Frontend configuration

Vite embeds public configuration at build time. Set these Coolify build arguments:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`, when used
- `GOOGLE_MAPS_PLATFORM_KEY` and/or `VITE_GOOGLE_MAPS_PLATFORM_KEY`, when Maps is used

Add the permanent hostname in Firebase Authentication authorized domains. Google
popup sign-in uses the configured Firebase auth domain with the OAuth redirect URI
`https://<firebase-auth-domain>/__/auth/handler`.

## Chapa configuration

Keep the current Test key and matching webhook secret for testing. Hosted checkout
uses Chapa v1; there is no separate v2 key.

When the permanent Coolify hostname is ready, configure the same dashboard mode:

- Webhook: `https://<your-domain>/api/chapa/webhook`
- Secret hash: exact value of `CHAPA_WEBHOOK_SECRET`
- Successful and failed payment webhooks: enabled
- Callback: `https://<your-domain>/api/chapa/callback`
- Return: `https://<your-domain>/?payment_return=1`

Local tunnel testing requires these URLs and `APP_URL` to use the active tunnel.
Temporary `trycloudflare.com` addresses change when a new tunnel is created.
Populate verification-only URL/domain inputs in `.env.example`, then run:

```powershell
npm run check:payment-config
```

The checker compares configured URLs/domains; it does not log in to or modify
external dashboards.

## Owner setup and data restore inside Coolify

For a new installation, set `PRIMARY_ADMIN_EMAIL` in Coolify's runtime environment
before your manual deployment with its persistent volume. The backend creates the
primary account during startup. After changing that email, restart the application
to revoke the prior environment-managed account and synchronize the new one.
You can inspect database counts from the container terminal at `/app/backend`:

```sh
node db-cli.js status
```

To move local data, export locally and transfer the JSON securely into `/app/data`.
Import into a new database file so startup defaults or an existing owner record do
not conflict with the create-only restore:

```sh
DATABASE_PATH=/app/data/restored.sqlite node db-cli.js import data/local-export.json
DATABASE_PATH=/app/data/restored.sqlite node db-cli.js owner your-google-account@example.com
DATABASE_PATH=/app/data/restored.sqlite node db-cli.js status
```

The JSON path resolves against `/app`, not `/app/backend`. Set Coolify's
`DATABASE_PATH` to `/app/data/restored.sqlite` and redeploy after validating the
restored counts. Keep the original database until the restored app is verified.
If the export contains the owner record, `owner` reports it already exists.
Imports never overwrite existing records.

Verify `/health`, `/ready`, and `/api/chapa/webhook` readiness. Complete a Test-mode
hosted payment and confirm the order becomes paid only after backend verification
of the reference, amount, currency, and successful status. Confirm the cart clears
and repeated webhooks do not duplicate completion.

Deployment, dashboard configuration, production data imports, and switching to
Live mode are manual actions. These instructions do not deploy or rotate keys.

### Copy existing Firestore data before switching to Coolify

The old web migration endpoint is no longer attached to the application. The
SQLite application does not require an old Firestore copy. Any deliberate legacy
import must be performed separately by an authorized administrator; the retained
migration library is disabled by default and requires explicit local admin checks.

## Security checks before the first deployment

Run `npm run security:check` to require clean dependency audits, type checks,
security/regression tests and production builds. See `SECURITY_REVIEW.md` for the
findings and the limits of the verification.

- Set the stable HTTPS `APP_URL`, primary admin email and runtime secrets in
  Coolify, then verify Firebase authorized domains, OAuth redirect URIs and Chapa
  URLs against that same hostname. Keep Chapa Test mode until the hosted flow has
  been exercised on that domain.
- Restrict the public Maps browser key to the intended HTTP referrers and APIs.
  Firebase public configuration is expected in the browser; payment keys,
  integration keys, signing secrets and admin configuration are server-only.
- Legacy Firestore access is denied by the prepared `firestore.rules`. Apply the
  rules deliberately with `firebase deploy --only firestore:rules --project <your-project-id>`
  if retaining the old cloud database. No rules have been
  deployed by this audit.
- The Coolify dashboard itself currently uses public HTTP. Put its administration
  and MCP connection behind HTTPS before using production secrets. The temporary
  HTTP test approval does not change production transport requirements.
- Build and scan the actual production container, configure the private persistent
  volume, and test Google sign-in, Maps, receipts and a Test-mode Chapa return on
  the final HTTPS hostname. Local Docker was unavailable during this audit, so
  container OS vulnerabilities and the VPS firewall were not verified here.

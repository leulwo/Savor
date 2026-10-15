# Security review — Savory

Reviewed 15 October 2026, before Coolify deployment. Active source:
`C:\Users\leull\Documents\SAVORY`.

## Scope and result

This review covers the Express application, local SQLite adapter and generic data
API, Firebase authentication and staff authorization, Chapa/order/Shipday flows,
frontend credential handling and output, dependency lockfiles, image handling,
browser protections, Docker configuration and legacy Firestore rules. Parallel
reviews and isolated regression tests were used. No live payment, delivery,
database wipe, deployment, credential rotation or remote rules change was made.

The confirmed application issues found in this review were fixed locally. This
is a bounded source and test review, not a guarantee that undiscovered flaws or
infrastructure vulnerabilities do not exist. Dependency advisories describe
affected packages; they do not by themselves prove an exploitable app path.

## Findings and fixes

| Area | Finding | Fix |
| --- | --- | --- |
| Redirect integrity | Incoming Host/Forwarded headers influenced payment callback and return URLs; external checkout URLs were weakly checked. | Canonical configured HTTPS production origin, strict hosted Chapa URL checks, validated external links and no provider redirects. |
| Payment state | Settlement checks occurred outside the write transaction; failed hosted attempts could be treated as definitively unpayable; late state updates and refunds/reversals could conflict. | Identity/reference/cent amount/currency/mode checks inside settlement transactions, terminal-state guards, verified refund/reversal transitions, fulfillment holds on conflicting adjustments, reconciliation of legacy failures, explicit provider cancellation before abandoning payable checkouts. |
| Order/fulfillment integrity | Cash ordering could bypass the COD toggle; manual updates accepted invalid state changes; shipping could race or update orphan/unpaid orders. | Authoritative shared pricing, COD enforcement, atomic permission-scoped state transitions, paid-online gates, persisted Shipday claims, bounded provider requests and associated monotonic webhook updates. |
| Promotions/retry abuse | Concurrent hosted checkouts could consume capped discounts without reserving capacity; changed details could generate competing payable references. | Transactional reservation, consumption and safe release; immutable bookkeeping; resume/cancel before replacing payable checkouts; maximum three unresolved online attempts per account, claimed atomically. |
| Stored input | Customer fields could contain objects that crash public/admin React rendering; malformed paths/grants were insufficiently checked. | Typed bounded input, field/path and prototype protection, validated grants, normalized active accounts, defensive rendering of legacy records. |
| Private data | Account switches could retain checkout details/notifications; receipt QR and fallback-avatar URLs disclosed details to third parties. | Account-scoped caches, stale-response guards, private-state cleanup, local QR generation and local icon fallbacks. |
| Credential destination | Authenticated fetch accepted arbitrary destinations and redirects; legacy settings could expose stored integration keys. | Same-origin `/api/` token destination checks, redirect rejection, and nested server-secret redaction in settings responses and browser exports. |
| Spreadsheet output | Customer-supplied formula strings could become executable spreadsheet cells; old SheetJS dependency had published advisories. | CSV formula neutralization, literal-string ExcelJS exports and removal of the old dependency. |
| Availability | Large unauthenticated bodies, unbounded query materialization and unlimited/slow live-update streams amplified resource use. | Authentication-gated media limits, bounded JSON/query sizes, streaming/bounded SQLite result selection, IP and authenticated-account throttling, connection/time limits and SSE backpressure coalescing. |
| Browser/runtime | Missing standard browser protections, dev server accepted arbitrary hosts, runtime container used root and `.env` could override runtime secrets. | Helmet/CSP with OAuth-compatible opener policy, exact dev host allowlist, private SQLite permissions, unprivileged container and runtime-first configuration. |
| Legacy database | Retained migration bootstrap and Firestore rules represented an unused alternate access surface. | Runtime migration routes removed, retained importer disabled/locally authorized, deny-all legacy rules prepared. Remote rules still require deliberate deployment. |
| Dependencies | Initial lockfile audits each reported 23 advisory entries, including a critical transitive proxy package. | Compatible patched releases and narrow overrides; removed unused AI SDK and replaced SheetJS. Final dependency audit results are recorded below. |

## Validation

The final `npm run security:check` completed successfully on 15 October 2026:

- Backend npm audit: **0 known vulnerabilities**.
- Frontend npm audit: **0 known vulnerabilities**.
- Backend tests: **150 passed, 0 failed**.
- Frontend tests: **29 passed, 0 failed**.
- Frontend and backend TypeScript checks: **passed**.
- Frontend and backend production builds: **passed**.

Repeat with `npm run security:check`. The local execution log is
`data/security/final-security-check.log` (ignored by Git). Production tests use
disposable SQLite fixtures and synthetic credentials. Outbound network is denied
except exact synthetic Chapa verification URLs handled by an in-process stub;
no real provider requests are made by these tests. Signed adjustment tests cover
valid refunds/reversals, replay, late success, mismatched identity and outages.
The frontend build reports large bundle warnings; these do not fail the build.

Additional checks completed:

- Pattern scan of 79 application source files and 21 Git commits found no matching
  private-key, service-account or Chapa credential literals. This is not a scan of
  every possible secret format.
- Compared six configured private values against five generated JS/CSS assets;
  none appeared in the public bundle. Values were not printed.
- Corrected the local `.env` APP_URL to include `https://`; malformed origin
  errors now give a configuration message without echoing the input value.
- Restarted the updated development server on port 3000. `/`, `/health` and
  `/ready` returned 200; unauthenticated `/api/orders` returned 401. API responses
  used `Cache-Control: no-store`, and `X-Powered-By` was absent.
- Spreadsheet round-trip tests preserve formula-looking customer strings as text.
- No SQL injection was found in the inspected parameterized SQLite queries.

## Deployment requirements and verification limits

1. Supply the final HTTPS app origin and matching Firebase/OAuth/Chapa settings.
   Configure proxy trust using the actual network and keep app port 3000 private.
2. Configure HTTPS for the Coolify administration/MCP endpoint before production
   secrets are used there. Only a temporary HTTP connectivity test was approved.
3. Apply the prepared legacy Firestore deny-all rules if the old cloud store is
   retained. This review does not modify deployed cloud rules.
4. Build/scan the final Docker image and verify the host firewall, volume ownership,
   backups and recovery. Docker was unavailable locally, so no image/OS scan or
   VPS hardening claim is made.
5. Exercise Google sign-in, Maps, receipts and hosted Chapa Test checkout on the
   final domain. Provider behavior and CSP compatibility on that hostname cannot
   be proved by mocked/local tests. Real payment and delivery creation were avoided.

Abandoned hosted checkouts retain reserved promo capacity until Chapa confirms
cancellation or nonexistence. Customers can resume or cancel them in My Orders;
there is no automatic background cleanup. Releasing reservations solely because
a local timer expired would allow a still-payable checkout to exceed the promo
limit. The per-account attempt cap and creation throttles limit reservation abuse;
they are not protection against unlimited newly registered accounts.

ExcelJS's upstream prebuilt browser bundle includes vendor code; npm overrides
patch installed dependencies, not that embedded bundle. The app only writes
literal-string workbooks and does not parse uploaded workbooks. The older UUID
buffer APIs described by its advisory are not reachable through this export flow;
the exported v4 usage and workbook round trip were checked.

## Primary references

- [Express production security](https://expressjs.com/en/advanced/best-practice-security/)
- [Express proxy trust](https://expressjs.com/en/guide/behind-proxies/)
- [Helmet browser headers](https://helmet.js.org/)
- [Chapa hosted checkout](https://developer.chapa.co/integrations/accept-payments)
- [Chapa verification](https://developer.chapa.co/integrations/verify-payments)
- [Chapa webhooks](https://developer.chapa.co/integrations/webhooks)
- [Chapa transaction cancellation](https://developer.chapa.co/integrations/transaction-cancel)
- [Google Maps CSP guidance](https://developers.google.com/maps/documentation/javascript/content-security-policy)

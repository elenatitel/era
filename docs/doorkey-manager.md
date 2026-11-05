# DoorKey Manager

DoorKey Manager is a separate service in this repository (`apps/doorkey-manager`),
not the old Mac Python test server. ERA is the reservation authority and creates
single-use enrollment QR codes **after check-in**. The reader authenticates the
phone locally; Home Assistant receives the successful-access Matter event and
runs the existing automation. Neither ERA nor Manager calls an actuator in this flow.

## Operator flow

1. Settings → Rooms → Door access: register the ESP32's numerical wire ID and
   uncompressed P-256 public key (130 hex characters beginning `04`). Give it a label.
   Obtain the identity from a trusted console/provisioning channel, not an unauthenticated
   BLE advertisement. Renaming this label does **not** change the firmware's BLE name.
2. Assign a room and check in the reservation normally.
3. Reservation → DoorKey → Create phone invitation. The QR/link enrolls one phone,
   expires after ten minutes, and is secret. Generate a separate invitation per guest.
4. The phone generates/keeps its private key locally and proves possession during
   redemption. Manager signs a permit for the room reader and phone public key.
5. On approach, the phone relays the signed reader challenge to Manager. Manager
   verifies both device signatures and asks ERA whether the stay/version is still valid.
   Only then does it return a signed, permit-bound approval for this challenge.
6. Revoke a phone or all stay access from the reservation. Checkout, cancellation,
   no-show and room moves invalidate the ERA access version through a DB trigger.
   Arrival/departure edits, room activity and tenant suspension are checked live.

Before check-in there is no grant to redeem. Whole-stay revocation also invalidates
pending invitations. Creating a new invitation after revocation starts a new version;
old permits/invitations never revive. Limit: 20 active phones per access version.
Permits expire at checkout or 30 days, whichever is earlier; extensions beyond the
original permit expiry require enrollment again. An approval already issued can
remain usable for the reader's current, single-use challenge lifetime (30 seconds
in the prototype). Server unavailability denies new access.

The old permanent room QR + reusable PIN/browser-unlock UI is replaced. Legacy API
routes return 410 by default (`LEGACY_DOOR_ACCESS=false`); their data is retained
for rollback. No Home Assistant URL/token is needed by the new flow.

## Deployment and keys

Helm charts: `era-doorkey-manager`, `era-doorkey-db`, plus the ERA API bridge
configuration. Argo CD child Applications use digest-locked OCI charts from Harbor.
CI builds `doorkey-manager` for amd64 and arm64. Database and restricted roles are
created on the **existing** CloudNativePG `postgres-geo` cluster; no new PostgreSQL
server is deployed. A separate logical DB isolates issuer data from PMS runtime roles.

Runtime Secrets (not Helm values, Git, container layers or API responses):

- `era-staging/era-doorkey-credentials`: DATABASE_URL, DATABASE_MIGRATION_URL,
  ISSUER_PRIVATE_KEY (P-256 private scalar, 64 hex), SERVICE_TOKEN (32 random bytes,
  base64url). Only the migration init container receives the owner URL.
- `era-staging/era-doorkey-bridge`: SERVICE_TOKEN only. ERA never gets the issuer private key.
- `postgres/era-doorkey-staging-owner` and `era-doorkey-staging-app`: CNPG basic-auth
  Secrets with username/password, matching the role names in the database chart.

Back up the DB **and issuer private key** securely. Losing/replacing the issuer key
requires updating reader/app trust and reissuing permits. This staging deployment
retains the prototype issuer for continuity; a production deployment must provision
its own issuer. Rotation/key rings, per-reader key provisioning over Matter and BLE
renaming are separate client/provisioning work, not implemented by this backend.

Public staging base: `https://doorkey-staging.cloud.retreat480.com`.
The public HTTPRoute exposes `/v1/*` and `/enroll` only. `/internal/*` is ClusterIP-only
through this gateway and additionally requires the service token. Do not expose
Manager with an ingress catch-all. ERA validation is service-token authenticated,
not cookie authenticated. Native endpoints accept no staff/browser cookies and no
CSRF exemption is added to staff ERA routes. TLS terminates at the existing gateway.
Public config returns a public key for diagnostics, not an automatically trusted root.
Apps must pin/securely provision the expected issuer and allowed Manager origin.

Health: internal `GET /health` checks PostgreSQL; public `GET /v1/config` reports
protocol and issuer public key. Startup fails on missing/invalid key/config.
Database migrations use an advisory lock and separate owner credentials. Audit is
append-only for the runtime role; raw QR tokens and private keys are never audited.
Transient invitations/rate buckets are periodically pruned. Permit/audit history
is retained; set an operator retention policy and monitor DB capacity.

## Mobile / firmware contract (protocol 2)

**The existing iOS app and H2 demo need a client update before using this service.**
It intentionally does not expose unrestricted `/permit` or `/time` compatibility
routes: the demo time proof can be borrowed by a revoked phone because it is not
bound to a specific permit. No firmware was flashed or door opened by deployment.

All integers are little endian, signatures P-256 ECDSA/SHA-256 raw `r || s` (64 bytes).
Public keys are uncompressed X9.63 (65 bytes). Domain strings below are UTF-8 with
no terminator. SHA256 means the 32 raw bytes, not its ASCII hex form.

- QR: `BASE/enroll#invite=TOKEN`. Secret is in the URL fragment, not a query/path
  logged by gateways. A plain browser shows instructions; the native app must scan
  and parse this URL. Universal Links are not configured by this service.
- `POST /v1/redeem`: `{invite, publicKey: HEX, signature: HEX}`. Signature covers
  `DoorKey-redeem-v1 || ASCII(TOKEN) || PHONE_PUBLIC_KEY`. Transactional single-use
  redemption returns `{deviceId, protocol:2, permit:BASE64, validUntil, door}`.
- Permit is unchanged from prototype: `version=1:u8 || door:u32 || from:u64 ||
  until:u64 || phonePublicKey:65 || issuerSignature:64` (150 bytes).
- `door` contains `{id,name,publicKey,certificate:BASE64}`. Verify its certificate
  over `DoorKey-device-v1 || door:u32 || doorPublicKey:65` with the pinned issuer.
- The reader challenge is unchanged: `door:u32 || nonce:16 || readerSignature:64`
  (84 bytes), signature over `DoorKey-door-v1 || door:u32 || nonce:16`.
- `POST /v1/authorize`: `{permit:BASE64, challenge:HEX, signature:HEX}`. The phone
  signature covers `DoorKey-authorize-v2 || SHA256(permit) || completeChallenge:84`.
  Manager rejects duplicate reader nonces across replicas and fails closed on ERA
  validation failure, expiration, revocation, disabled reader or invalid signatures.
- Response `{protocol:2,timeProof:BASE64}` is `epoch:u64 || issuerSignature:64`.
  Firmware must verify `DoorKey-time-v2 || door:u32 || nonce:16 || epoch:u64 ||
  SHA256(permit)` instead of the old `DoorKey-time-v1` payload. Do not accept v1 as
  a fallback once adopting this manager.
- BLE AUTH frame can retain its 286-byte shape: `permit:150 || timeProof:72 ||
  phoneSignature:64`, with the existing final phone signature domain
  `DoorKey-auth-v1 || door:u32 || nonce:16 || SHA256(first222bytes)`.
  Firmware must enforce fresh single-use challenges and verify proximity locally.

Reader identities are immutable after registration (wire ID/key unique globally).
Labels and enabled status are editable. Hardware replacement is deliberately refused
rather than silently transferring live permits; an explicit replacement workflow
must revoke all access and reprovision the reader trust first.

## Validation

`npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high`.
The Manager suite uses real PostgreSQL with separate owner/runtime roles and verifies
single-use enrollment, public-key binding, signed reader/phone challenges, replay,
live eligibility/version checks, per-device revocation and append-only audit.
ERA tests cover CSRF/RBAC/RLS, after-check-in issuance, terminal-state triggers,
tenant suspension, date changes and timezone/DST checkout boundaries.

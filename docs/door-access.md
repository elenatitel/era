# Guest door access

Each property's Home Assistant configuration lives under **Settings → Property →
Home Assistant**: HTTPS URL, access token, enabled flag. Save before testing. The
test uses `GET /api/`, never an actuator service. Tokens are AES-256-GCM encrypted
using the existing runtime ENCRYPTION_KEY and never returned to the browser.
Changing the URL requires a token and revokes existing keys for that property.

**Settings → Rooms → Door access** assigns one `lock.*` or individual `script.*`
entity to a room. Enable the room, download its permanent QR and print it. QR
links are random identifiers, not credentials. Changing an entity revokes old
keys. The same room number in another property is entirely independent.

From a confirmed or checked-in reservation with an assigned room, reception can
**Generate / rotate PIN**. The six-digit reusable PIN is shown once; securely share
it with the occupants. Each person scans the QR, enters the PIN on their phone,
and receives an opaque Secure/HttpOnly/SameSite=Strict room-path cookie. PINs are
stored only as domain-separated HMACs; device tokens only as SHA-256 hashes.
At most 20 unexpired devices can be activated per key version. Rotate the PIN to
invalidate all previous devices, or revoke a specific device from the reservation.

Access starts only after ERA check-in. Each request checks the active tenant,
current reservation status, assigned room, room activity, enabled integrations,
revocation/version, device expiry and current departure/checkout hour in the
property timezone. Checkout, cancellation, no-show or a room change permanently
revokes the grant via a database trigger. Extensions/shortened dates are checked
on each use; devices have an independent 30-day maximum lifetime. After longer
stays they must activate again. Check-in, folio and payment behavior is unchanged:
opening a door never performs accounting check-in.

Guests use `/door/PUBLIC_ID` and `/api/public/doors/PUBLIC_ID/*`, without staff
login or Keycloak. Existing booking links and `pms_guest` cookies cannot unlock
doors. Public state changes retain ERA's Origin + double-submit CSRF guard.
The guest frontend never refreshes staff sessions or retries an unlock. A full
slide (or arrow keys then Enter/Space) sends a POST. Scanning or activating never
sends a hardware command.

Home Assistant receives `POST /api/services/lock/unlock` with `entity_id`, or the
individual `POST /api/services/script/SCRIPT_NAME` with an empty JSON body.
Reserved script services are refused. A successful response means **command
accepted**, not verified physical door position. Errors/timeouts never show a
success screen and are not retried automatically. Only configured backend
entities and credentials are used, regardless of guest input.

Connection policy: public DNS hostname, HTTPS on standard port 443, valid TLS,
no URL userinfo/path/query, no redirects. Resolved private/loopback/link-local and
special ranges are refused, DNS is pinned for the actual connection to prevent
rebinding. LAN-only or VPN-private HA endpoints need a separately designed,
operator-controlled network policy; the web form cannot authorize arbitrary
internal targets. DNS deadline is two seconds, service deadline ten seconds.

Shared PostgreSQL counters enforce PIN limits per room/IP and room command limits
across replicas/restarts. One command per five-second fixed bucket and ten per
minute; all devices for a room share these limits. An uncertain command consumes
its allowance. This suppresses repeats, but cannot guarantee exactly-once physical
execution across network/process failures. Audit records track device activation,
rotation, revocation and command results, without raw PINs or HA tokens.

Permissions: property.manage configures HA, rooms.manage configures entities/QRs,
frontdesk.checkin + reservations.read manage reservation keys/devices. Existing
property restrictions apply to all staff endpoints. Tenant data uses forced RLS;
the global QR index contains only public ID, room ID and tenant ID. The new
migration is additive; existing rooms/integrations start unconfigured/disabled.

No new GitHub Actions or Kubernetes secrets are required. Existing ENCRYPTION_KEY
must be retained/restored with the database. No UNVRS database import is needed:
configure the desired property, copy the appropriate HA token securely, assign
entities, and print ERA QR codes. UNVRS device cookies are not transferable.

Source API reference: https://contributors.home-assistant.io/core/internals/rest-api/

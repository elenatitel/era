# Staff authentication with Keycloak

Staging uses the `staging` realm at `https://keycloak.cloud.retreat480.com` and
its own confidential client `era-staging`. ERA's organization memberships,
permission bundles, property restrictions and local `is_platform_admin` flag
remain authoritative. Keycloak roles, usernames and matching email addresses
never grant ERA privileges.

## Identity and sessions

The immutable `(oidc_issuer, oidc_subject)` pair is unique on each existing ERA
user. Local ERA UUIDs and all references to them remain unchanged. Initial
migration binds accounts explicitly; it does not guess identities from email.
The platform bootstrap subject is supplied by the operator in `era-oidc`, alongside
the client secret. The seed job refuses to overwrite an existing different
identity. The API has no Keycloak administrative credentials or service account.

The backend uses Authorization Code + PKCE S256, state, nonce, fixed callback
URLs and JWKS signature/issuer/audience/expiry validation via `openid-client`.
Application cookies retain ERA's existing HttpOnly, Secure, SameSite=Strict
session model. Only the short-lived encrypted OAuth flow cookie uses SameSite=Lax.
Provider access/refresh tokens are never given to browser JavaScript. Provider
refresh and ID tokens are encrypted using the existing AES-GCM `ENCRYPTION_KEY`
and attached to a stable application session family in `oidc_sessions`.

Every protected request checks the application session and current ERA access.
Provider identity is revalidated by refresh at least every five minutes of
activity, including on application-token refresh. Rotation is serialized in
PostgreSQL and committed independently of later application authorization
errors. Disabled/revoked provider sessions fail closed at the next revalidation.
A provider outage returns 503 without destroying a valid session. Application
logout revokes locally even when the access cookie expired or the provider is
unavailable, and normally performs RP-initiated Keycloak logout. Changes to ERA
memberships/permissions remain effective on the next request.

`JWT_SECRET` remains needed for application and public guest sessions.
`ENCRYPTION_KEY` remains needed for existing PII, integration secrets and provider
tokens: preserve it. Passwords, password recovery and MFA endpoints are disabled
in Keycloak mode; development can explicitly use `AUTH_PROVIDER=local`.

## Client and MFA configuration

The client has authentication enabled, Authorization Code enabled, PKCE S256
required, and implicit flow, password/direct grants and service accounts disabled.
Only these URIs are allowed:

- Callback: `https://era-staging.cloud.retreat480.com/api/auth/oidc/callback`
- Logout callback: `https://era-staging.cloud.retreat480.com/api/auth/oidc/logged-out`
- Origin: `https://era-staging.cloud.retreat480.com`

Use the `profile` and `email` scopes and an ID-token AMR protocol mapper
(`oidc-amr-mapper`). ERA uses a copy of the browser flow, `era-staging-browser`,
bound **only to this client**. Its password and OTP executions have their own
configurations: `default.reference.value=pwd` / `otp`, with
`default.reference.maxAge=3600`. The shared realm and UNVRS browser flow are not
changed. No user-attribute mapper supplies authentication-method claims.

Organization and platform MFA policies require verified ID-token authentication
methods containing **both `pwd` and `otp`**, not the legacy local MFA-enrollment
flag. Users configure OTP in Keycloak's account console, then use **Sign in again
with MFA** to perform a new password/OTP login. Ordinary SSO can remain available
for organizations without a mandatory MFA policy. Mandatory platform MFA stays
controlled by the existing `PLATFORM_ADMIN_REQUIRE_MFA` setting (off on staging).

The profile page links to Keycloak for credentials and MFA. Provider email
recovery follows the shared realm's SMTP/recovery configuration; the ERA/Mailpit
SMTP configuration is not silently copied into the shared realm. Configure real
provider email delivery before relying on self-service account recovery.

## Invitations and onboarding

For staging, create people in Keycloak first (public realm registration remains
unchanged). Existing explicitly linked people can sign in immediately using their
Keycloak account, independently of their displayed ERA contact email.

New email invitations redirect to Keycloak. Acceptance requires a **verified,
matching email address**, validates the immutable subject, and creates the new
ERA user/membership only after that proof. An existing global ERA email is never
automatically rebound to a different subject. The platform operator must explicitly
link an unmigrated legacy identity. Invitations are consumed under a database
lock, cannot be reused and cannot overwrite an existing or disabled membership.
All ERA roles and property-grant restrictions still apply to the invitation.

Default staging demo accounts are migration fixtures, not shared Keycloak roles.
They have separate `era-*` identity usernames; email/password login can be used
on the Keycloak form. The ERA platform administrator is not a Keycloak platform
administrator. Its local privilege flag is preserved explicitly.

## Authorization corrections

The housekeeping board now hides guest identity/arrival details without both
`guests.read` and `reservations.read`; staff without `housekeeping.manage` see
only their own assigned tasks. Restricted administrators cannot grant all
properties or properties beyond their own scope, nor manage broader memberships.
Organization-wide role definitions require organization-wide access.

These restrictions preserve ERA's existing distinction: an organization may own
multiple properties, with one role per organization membership. Organization-wide
permissions such as CRM access retain their existing scope.

## Deployment

Helm defaults staging to Keycloak. Runtime Secret `era-oidc` must contain
`OIDC_CLIENT_SECRET` and the explicit `OIDC_BOOTSTRAP_SUBJECT`. No new GitHub
Actions secrets are needed. Rotate runtime client credentials by updating the
secret and restarting the API. The additive migration preserves application
UUIDs, roles, booking data and public guest sessions; old local staff sessions
are rejected in Keycloak mode. Guest booking pages, private stay links, email
verification codes and signed Stripe webhooks remain independent of staff SSO.

Publish from a feature branch; the trusted workflow promotes digest-locked
charts into `main:gitops/staging`, then Argo synchronizes main. Local-provider
rollback is an explicit operator action, not a fallback on provider failures.
Existing local password hashes are retained for development/rollback and do not
track later password changes made in Keycloak.

# Security model

## Tenant isolation
- PostgreSQL Row-Level Security, `FORCE`d on all 17 tenant tables (`apps/api/drizzle/0001_rls.sql`); a test fails if a table is missed.
- Runtime role `pms_app` has no superuser/`BYPASSRLS`, owns no tables and cannot `UPDATE/DELETE` audit tables or `DELETE` invoices. Migrations run as a separate owner role.
- The tenant is bound per transaction (`set_config(..., true)`), so pooled connections never leak context.
- Services validate every referenced id (guest, room, company…) inside the tenant transaction before use.

## Authentication
- Argon2id password hashing (OWASP parameters), 12+ character passwords, constant-time responses for unknown accounts.
- Lockout after 5 failed attempts (15 min); per-IP rate limits on all auth endpoints.
- TOTP 2FA (RFC 6238) with replay protection and 10 single-use recovery codes (stored hashed). Mandatory for platform admins; organizations can require it for all members.
- Sessions: 15-minute JWT access token + opaque refresh token (stored hashed), rotated on every use. Reuse of an old refresh token revokes the whole session family. 7-day idle and 30-day absolute limits. Logout, password change and membership changes revoke sessions immediately (every request checks the session).
- Password reset and invitation tokens: random 256-bit, stored hashed, single use, expiring.

## Authorization
- Deny-by-default global guard; each route declares permissions. Property-level scoping per membership.
- Privilege-escalation guards: users can only grant permissions they hold, only owners grant or modify owners, nobody can change their own role, and the last owner cannot be removed.

## Web security
- Cookies: `HttpOnly`, `Secure` (production), `SameSite=Strict`; refresh cookie scoped to `/api/auth`.
- CSRF: Origin check + double-submit token on every state-changing request.
- Per-request nonce Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, `nosniff`, strict referrer and permissions policies; API sends `Cache-Control: no-store`.
- All input validated with shared Zod schemas; uniform error envelope without stack traces or SQL details.

## Data protection (GDPR)
- Identity document numbers and TOTP secrets are encrypted with AES-256-GCM; document numbers are masked unless the user has `guests.pii`, and every PII view is audited.
- Guest data export (Art. 15/20) and anonymization (Art. 17) that keeps legally required fiscal records; invoices store immutable party snapshots.
- Append-only audit log of business actions and a separate security event log for authentication events.

## Integrity
- A database exclusion constraint makes double-booking a room impossible; advisory locks prevent overbooking a room type under concurrency.
- Issued invoices are immutable (trigger); corrections are made with credit notes; numbering is gapless per series.

## Reporting a vulnerability
E-mail security@your-domain with details and reproduction steps. Please do not open public issues for vulnerabilities.

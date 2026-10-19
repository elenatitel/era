# era.

*A new era of hospitality.* Multi-tenant SaaS property management system for hotels: front office, reservations,
housekeeping, guest CRM, invoicing and payments — with tenant isolation enforced by the database,
role-based permissions, two-factor authentication and GDPR tooling. UI in Romanian and English.

| | |
|---|---|
| **API** | NestJS 12 · TypeScript · Drizzle ORM · PostgreSQL 17 (Row-Level Security) |
| **Web** | Next.js 16 (App Router) · React 19 · TanStack Query · Tailwind CSS 4 |
| **Shared** | `@pms/shared` — permission catalogue, role templates, Zod schemas, money/date helpers |
| **Ops** | Docker · Caddy (automatic HTTPS) · GitHub Actions |

## Modules in this release

| Module | What it does |
|---|---|
| **Property management** | Multiple properties per organization, room types, rooms, business date, VAT rates, document series |
| **Front office** | Arrivals / departures / in-house lists, check-in with room assignment and cleanliness checks, check-out with balance control, early departures |
| **Reservations** | Availability search, rate quotes, overbooking-safe booking, tape-chart calendar, cancellations, no-shows, night audit |
| **Rates** | Rate plans (BAR, B&B, non-refundable…), per-date dynamic prices and stop-sell per room type / plan, minimum stay |
| **Housekeeping** | Live room board, daily task generation, assignment, start / done / inspect workflow, out-of-order, mobile-first task view |
| **Guests & CRM** | Profiles with segments (VIP, business, agent), companies & agencies, stay history and lifetime value, encrypted ID documents |
| **Financial** | Folio charges & voids, payments & refunds, invoices, proformas, credit notes (storno) with gapless numbering, payments report, dashboard KPIs (occupancy, ADR, RevPAR) |
| **Booking engine** | Public booking page per hotel (`/book/<address>`): live availability and prices, guest details, card payment with Stripe (Payment Element, Apple Pay / Google Pay); rooms are held for 30 minutes until payment, confirmed by signed webhook |
| **Guest portal** | Private link per booking (no account): stay summary, balance, online check-in with ID details for every guest, protected by a 6-digit e-mail code; reception sees check-in, arrival time and requests |
| **Mobile** | Responsive UI + installable PWA manifest; housekeeping designed for phones |
| **Administration** | Team invitations, custom roles, per-property access, audit log, organization 2FA policy, platform super-admin |

### Roadmap (next phases)

Revenue management automation · In-stay mobile ordering and requests · Express check-out ·
Loyalty programs · Event & conference management · Restaurant POS · Upselling · Channel manager / OTA integrations ·
Romanian e-Factura (ANAF) · SaaS subscription billing.

## Multi-tenancy, roles & permissions

* **Tenant = organization** (a hotel group). Each owns one or more properties. Users are global and can belong to several organizations with a different role in each; they switch from the organization picker.
* **Isolation is enforced by PostgreSQL Row-Level Security.** Every tenant-owned table has a forced `tenant_isolation` policy on `tenant_id = current_setting('app.tenant_id')`. The API connects as `pms_app`, a role that is neither superuser nor `BYPASSRLS` (the API refuses to start in production otherwise) and sets the tenant per transaction. A forgotten `WHERE` clause returns nothing instead of another hotel's data.
* **Permissions** (`packages/shared/src/permissions.ts`) are the unit of authorization; **roles** are per-tenant bundles of permissions. Every endpoint declares what it needs with `@Perms(...)`, and the global guard denies by default.
* **Property scoping:** a membership can be limited to specific properties.

Default roles created for each organization:

| Role | Typical user | Highlights |
|---|---|---|
| Owner *(system)* | Hotel owner / GM | Everything, including security policy and roles |
| Property Manager | Hotel manager | Everything except organization settings and role editing |
| Front Desk | Receptionist | Reservations, check-in/out, folios, payments, invoices, guest PII |
| Housekeeping Supervisor | Head housekeeper | Room board, assign & inspect tasks, out-of-order |
| Housekeeper | Room attendant | Only their own tasks; mark rooms clean |
| Revenue Manager | Revenue / sales | Rate plans, dynamic prices, reports |
| Accountant | Finance | Invoices, credit notes, refunds, voids, reports |
| *Custom roles* | — | Any combination; you can only grant permissions you hold |

The **platform administrator** (you, the SaaS operator) creates organizations, suspends or reactivates them, and must use 2FA. Platform admins do not see hotel data unless they are invited into an organization.

## Local development

Requirements: Node.js 22+, and either Docker or nothing else (an embedded PostgreSQL script is included).

```bash
npm install
cp apps/api/.env.example apps/api/.env      # then fill JWT_SECRET and ENCRYPTION_KEY
```

Fill the secrets:

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" && echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
```

Start PostgreSQL — either with Docker:

```bash
docker compose up -d postgres
```

…or without Docker (creates `apps/api/.pg-dev`, then keep it running in its own terminal):

```bash
node apps/api/scripts/local-db.mjs
```

Migrate, seed a platform admin and a demo hotel, then run both apps:

```bash
npm run build -w @pms/shared && npm run build -w @pms/api
npm run db:migrate
npm run db:seed -- --demo
```

```bash
npm run dev:api
```

```bash
npm run dev:web
```

Open http://localhost:3000. The seed prints the demo password; demo users are
`owner@`, `manager@`, `frontdesk@`, `hk-lead@`, `housekeeper@`, `accounting@`, `revenue@demo.test` —
sign in as different roles to see how the app adapts. Without SMTP, invitation and password-reset
e-mails are printed in the API console.

### Tests

```bash
npm test
```

Runs shared unit tests and an end-to-end API suite against a real (embedded) PostgreSQL:
RLS coverage of every tenant table, cross-tenant access attempts, RBAC and privilege escalation,
CSRF, account lockout, MFA with replay protection, refresh-token rotation and reuse detection,
concurrent overbooking, double room assignment, the full stay → invoice → credit note flow,
housekeeping permissions and GDPR erasure.

## Production deployment (Docker)

1. A Linux server with Docker, and a DNS record for your domain pointing to it.
2. Configure:

   ```bash
   cp .env.production.example .env.production
   ```

   Set `DOMAIN`, database passwords, `JWT_SECRET`, `ENCRYPTION_KEY`, SMTP and the platform admin.
3. Start everything (Caddy obtains TLS certificates automatically; migrations run before the API starts):

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   ```

4. Create the platform administrator:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm migrate node dist/db/seed.js
   ```

5. Sign in at `https://DOMAIN`, enable 2FA, open **Platform → New organization**. The hotel owner receives an invitation e-mail.

**Online booking with Stripe:** each hotel uses its own Stripe account. In **Settings → Online booking**, set the web address, paste the publishable and secret keys, add the shown webhook endpoint in Stripe (event `payment_intent.succeeded`) and paste its signing secret. Without keys, online bookings are confirmed at once and paid at the hotel.

**Operations checklist:** schedule `pg_dump` backups of the `pgdata` volume off-site and test restores;
keep `ENCRYPTION_KEY` in a secret manager (losing it makes encrypted ID numbers and 2FA secrets unreadable);
the API rate limiter is in-memory, so run one API replica or put a Redis-backed limiter in front before scaling out;
point uptime monitoring at `/api/health`.

## Project layout

```
apps/api      NestJS API — src/<module>/, drizzle/ (SQL migrations incl. RLS), test/ (e2e)
apps/web      Next.js app — src/app/(auth), src/app/(app), src/components, src/lib
packages/shared  permissions, roles, schemas, helpers used by both
docker/       Caddyfile, Postgres init script
```

See [SECURITY.md](SECURITY.md) for the security model.

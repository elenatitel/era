-- Tenant isolation, integrity constraints and append-only audit trail.

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- A physical room can never be double-booked, even under concurrent requests.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_room_overlap"
  EXCLUDE USING gist ("room_id" WITH =, daterange("arrival", "departure", '[)') WITH &&)
  WHERE ("room_id" IS NOT NULL AND "status" IN ('tentative', 'confirmed', 'checked_in'));
--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_dates_check" CHECK ("departure" > "arrival");
--> statement-breakpoint
ALTER TABLE "folio_items" ADD CONSTRAINT "folio_items_quantity_check" CHECK ("quantity" > 0);
--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_occupancy_check" CHECK ("max_occupancy" >= "base_occupancy" AND "base_occupancy" >= 1);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles', 'memberships', 'audit_logs', 'properties', 'document_series', 'room_types', 'rooms',
    'rate_plans', 'rate_overrides', 'companies', 'guests', 'reservations', 'folio_items', 'payments',
    'invoices', 'invoice_lines', 'housekeeping_tasks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE applies policies to the table owner too; only superusers / BYPASSRLS roles skip them.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- A signed-in user may list their own memberships across tenants (tenant switcher), read-only.
CREATE POLICY own_memberships_read ON "memberships" FOR SELECT USING ("user_id" = app_current_user());
--> statement-breakpoint
-- ...and the names of the roles attached to those memberships.
CREATE POLICY own_roles_read ON "roles" FOR SELECT USING (
  EXISTS (SELECT 1 FROM "memberships" m WHERE m."role_id" = "roles"."id" AND m."user_id" = app_current_user())
);
--> statement-breakpoint

-- Audit trail is append-only, even for the table owner.
CREATE OR REPLACE FUNCTION app_forbid_modification() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();
--> statement-breakpoint
CREATE TRIGGER security_events_append_only BEFORE UPDATE OR DELETE ON "security_events"
  FOR EACH ROW EXECUTE FUNCTION app_forbid_modification();
--> statement-breakpoint

-- Issued fiscal documents are immutable except for status transitions.
CREATE OR REPLACE FUNCTION app_protect_invoice() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices cannot be deleted';
  END IF;
  IF NEW.total <> OLD.total OR NEW.number <> OLD.number OR NEW.series <> OLD.series
     OR NEW.issue_date <> OLD.issue_date OR NEW.bill_to <> OLD.bill_to OR NEW.type <> OLD.type THEN
    RAISE EXCEPTION 'issued invoices are immutable';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION app_protect_invoice();

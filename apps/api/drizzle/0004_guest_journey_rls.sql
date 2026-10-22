-- Companions of a stay are tenant data like every other guest record.
ALTER TABLE "reservation_guests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "reservation_guests" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "reservation_guests"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservations_hold_expires_idx" ON "reservations" ("hold_expires_at") WHERE "hold_expires_at" IS NOT NULL;

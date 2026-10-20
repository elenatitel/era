-- Extras, packages and promo codes are tenant data.
ALTER TABLE "extras" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "extras" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "extras"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE "rate_plan_extras" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rate_plan_extras" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "rate_plan_extras"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promo_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "promo_codes"
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
--> statement-breakpoint
ALTER TABLE "extras" ADD CONSTRAINT "extras_price_check" CHECK ("price" >= 0);
--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_value_check" CHECK ("value" > 0 AND ("discount_type" <> 'percent' OR "value" <= 100));
--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_uses_check" CHECK ("max_uses" IS NULL OR "used_count" <= "max_uses");

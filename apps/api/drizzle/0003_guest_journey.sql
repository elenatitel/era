CREATE TABLE "booking_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booking_sites_propertyId_unique" UNIQUE("property_id"),
	CONSTRAINT "booking_sites_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "guest_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_links_reservationId_unique" UNIQUE("reservation_id"),
	CONSTRAINT "guest_links_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "reservation_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"birth_date" date,
	"nationality" text,
	"document_type" text,
	"document_number_enc" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "stripe_publishable_key" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "stripe_secret_key_enc" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "stripe_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "hold_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "stripe_payment_intent_id" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "guest_locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "estimated_arrival" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "guest_requests" text;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "online_checkin_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_sites" ADD CONSTRAINT "booking_sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_links" ADD CONSTRAINT "guest_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_guests" ADD CONSTRAINT "reservation_guests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_guests" ADD CONSTRAINT "reservation_guests_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_sites_tenant_id_index" ON "booking_sites" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "guest_links_tenant_id_index" ON "guest_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reservation_guests_reservation_id_index" ON "reservation_guests" USING btree ("reservation_id");
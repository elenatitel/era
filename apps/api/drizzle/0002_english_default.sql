ALTER TABLE "tenants" ALTER COLUMN "default_locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" SET DEFAULT 'en';
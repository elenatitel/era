CREATE TABLE "oidc_sessions" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"id_token_enc" text NOT NULL,
	"provider_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mfa_verified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_provider" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "oidc_sessions" ADD CONSTRAINT "oidc_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oidc_sessions_expiry" ON "oidc_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_identity_unique" ON "users" USING btree ("oidc_issuer","oidc_subject");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_oidc_identity_pair" CHECK (("users"."oidc_issuer" IS NULL) = ("users"."oidc_subject" IS NULL));
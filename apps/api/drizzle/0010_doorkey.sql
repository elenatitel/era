CREATE TABLE "doorkey_access" (
	"reservation_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doorkey_access" ADD CONSTRAINT "doorkey_access_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorkey_access" ADD CONSTRAINT "doorkey_access_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doorkey_access" ADD CONSTRAINT "doorkey_access_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE doorkey_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE doorkey_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doorkey_access USING (tenant_id=app_current_tenant()) WITH CHECK (tenant_id=app_current_tenant());
--> statement-breakpoint
CREATE FUNCTION revoke_reservation_doorkey() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.status IN ('checked_out','cancelled','no_show') THEN
  UPDATE doorkey_access SET enabled=false,version=version+1 WHERE reservation_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reservation_doorkey_changed AFTER UPDATE OF room_id,status ON reservations FOR EACH ROW EXECUTE FUNCTION revoke_reservation_doorkey();

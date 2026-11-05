CREATE TABLE doorkey_access (
 reservation_id uuid PRIMARY KEY REFERENCES reservations(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
 version integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT true
);
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

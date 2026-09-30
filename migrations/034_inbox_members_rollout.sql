-- Preserve the inbox-only Cloudflare policy, plus the requested Anastasia access.
-- Existing database roles are authoritative and must not be overwritten.
SELECT pg_advisory_xact_lock(7342232);
WITH added AS (
 INSERT INTO inbox_members (email,role,created_by) VALUES
 ('jonas@realadvisor.com','admin','membership-rollout'),
 ('joan@realadvisor.com','user','membership-rollout'),
 ('guillaume@realadvisor.com','user','membership-rollout'),
 ('anastasia@realadvisor.com','user','membership-rollout')
 ON CONFLICT (email) DO NOTHING
 RETURNING email,role
)
INSERT INTO inbox_member_audit(email,actor,new_role)
SELECT email,'membership-rollout',role FROM added;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM inbox_members WHERE role='admin') THEN
  RAISE EXCEPTION 'Membership rollout requires an administrator';
 END IF;
END $$;

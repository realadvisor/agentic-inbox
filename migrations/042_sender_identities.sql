CREATE TABLE sender_identities (
 id text PRIMARY KEY,
 email text NOT NULL UNIQUE,
 mailbox_id text REFERENCES mailboxes(id) ON DELETE SET NULL,
 active boolean NOT NULL DEFAULT true
);
-- Prefer the live mailbox if synthetic fixtures and live mailboxes coexist.
INSERT INTO sender_identities (id,email,mailbox_id)
SELECT DISTINCT ON (address) address,address,id FROM (
 SELECT id, CASE WHEN email LIKE '%@ingest.realadvisor.com'
 THEN replace(email,'@ingest.realadvisor.com','@realadvisor.com') ELSE email END AS address
 FROM mailboxes WHERE email <> 'all@ingest.realadvisor.com'
) identities ORDER BY address,(id LIKE '%@ingest.realadvisor.com') DESC;
CREATE TABLE inbox_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 default_sender_identity_id text REFERENCES sender_identities(id)
);
INSERT INTO inbox_settings VALUES (true,(SELECT id FROM sender_identities WHERE email='info@realadvisor.com'));
ALTER TABLE emails ADD COLUMN sender_identity_id text REFERENCES sender_identities(id);
UPDATE emails e SET sender_identity_id=s.id FROM sender_identities s
WHERE e.delivery_status <> 'received' AND (e.sender=s.email OR e.sender=s.mailbox_id);

ALTER TABLE inbox_api_keys DROP CONSTRAINT inbox_api_keys_permissions_check;
ALTER TABLE inbox_api_keys ADD CONSTRAINT inbox_api_keys_permissions_check CHECK(cardinality(permissions)>0 AND permissions <@ ARRAY['mail:read','drafts:manage','mail:send','senders:manage','conversations:manage','webhooks:manage','classifications:read','classifications:review','classifications:run','folders:manage','agent:use']::text[]);

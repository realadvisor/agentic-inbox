-- Existing keys keep their current scopes. No data is seeded.
ALTER TABLE inbox_api_keys DROP CONSTRAINT inbox_api_keys_permissions_check;
ALTER TABLE inbox_api_keys ADD CONSTRAINT inbox_api_keys_permissions_check CHECK(cardinality(permissions)>0 AND permissions <@ ARRAY['mail:read','drafts:manage','mail:send','conversations:manage','webhooks:manage','classifications:read','classifications:review','classifications:run','folders:manage','agent:use']::text[]);

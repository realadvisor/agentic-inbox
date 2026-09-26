CREATE TABLE mailbox_contacts (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  sent_count integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  PRIMARY KEY (mailbox_id, email)
);
CREATE INDEX mailbox_contacts_email_search ON mailbox_contacts (mailbox_id, email text_pattern_ops);
CREATE INDEX mailbox_contacts_name_search ON mailbox_contacts (mailbox_id, lower(name) text_pattern_ops);

-- Stored recipient lists contain bare addresses. Share normalization between
-- the one-time backfill and future deliveries; never index drafts or failures.
CREATE FUNCTION contact_addresses(message emails)
RETURNS TABLE(email text) LANGUAGE sql IMMUTABLE AS $$
  SELECT DISTINCT lower(btrim(address))
  FROM regexp_split_to_table(CASE
    WHEN message.delivery_status = 'received' THEN message.sender
    WHEN message.delivery_status IN ('sent', 'simulated') THEN
      concat_ws(',', message.recipient, message.cc, message.bcc)
    ELSE '' END, '[,;]') AS address
  WHERE btrim(address) ~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
    AND lower(btrim(address)) <> lower(message.mailbox_id)
    AND lower(btrim(address)) <> replace(lower(message.mailbox_id), '@ingest.', '@')
    AND lower(btrim(address)) !~ '^(no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon|postmaster)@';
$$;

INSERT INTO mailbox_contacts (mailbox_id, email, last_used_at, sent_count)
SELECT e.mailbox_id, c.email, max(e.date),
  count(*) FILTER (WHERE e.delivery_status IN ('sent', 'simulated'))::integer
FROM emails e CROSS JOIN LATERAL contact_addresses(e) c
GROUP BY e.mailbox_id, c.email;

CREATE FUNCTION maintain_mailbox_contacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A retry or an unrelated message edit must not count a send twice.
  IF TG_OP = 'UPDATE' AND OLD.delivery_status = NEW.delivery_status THEN
    RETURN NEW;
  END IF;
  INSERT INTO mailbox_contacts (mailbox_id, email, last_used_at, sent_count)
  SELECT NEW.mailbox_id, c.email, NEW.date,
    CASE WHEN NEW.delivery_status IN ('sent', 'simulated') THEN 1 ELSE 0 END
  FROM contact_addresses(NEW) c
  ON CONFLICT (mailbox_id, email) DO UPDATE SET
    last_used_at = greatest(mailbox_contacts.last_used_at, excluded.last_used_at),
    sent_count = mailbox_contacts.sent_count + excluded.sent_count;
  RETURN NEW;
END;
$$;
CREATE TRIGGER maintain_mailbox_contacts AFTER INSERT OR UPDATE OF delivery_status
ON emails FOR EACH ROW EXECUTE FUNCTION maintain_mailbox_contacts();

ALTER TABLE emails DROP CONSTRAINT emails_delivery_status_check;
ALTER TABLE emails ADD CONSTRAINT emails_delivery_status_check CHECK (delivery_status IN ('received','draft','simulated','sending','sent','failed','unknown'));
ALTER TABLE emails ADD COLUMN raw_storage_key text;
ALTER TABLE emails ADD COLUMN reply_to text;
CREATE TABLE outbound_requests (
  mailbox_id text NOT NULL REFERENCES mailboxes(id),
  request_id uuid NOT NULL,
  payload_hash text NOT NULL,
  email_id uuid NOT NULL REFERENCES emails(id),
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, request_id)
);
COMMENT ON TABLE emails IS 'Mailbox messages; raw MIME and attachment bytes are stored in private object storage.';

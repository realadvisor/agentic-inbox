CREATE TABLE mailboxes (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE folders (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  is_deletable boolean NOT NULL DEFAULT true,
  PRIMARY KEY (mailbox_id, id),
  UNIQUE (mailbox_id, name)
);

CREATE TABLE emails (
  id uuid PRIMARY KEY,
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  folder_id text NOT NULL,
  subject text NOT NULL DEFAULT '',
  sender text NOT NULL,
  recipient text NOT NULL,
  cc text NOT NULL DEFAULT '',
  bcc text NOT NULL DEFAULT '',
  date timestamptz NOT NULL DEFAULT now(),
  read boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  body text NOT NULL DEFAULT '',
  in_reply_to text,
  email_references text,
  thread_id uuid NOT NULL,
  message_id text NOT NULL,
  raw_headers text,
  delivery_status text NOT NULL DEFAULT 'received'
    CHECK (delivery_status IN ('received', 'draft', 'simulated')),
  UNIQUE (mailbox_id, message_id),
  UNIQUE (mailbox_id, id),
  FOREIGN KEY (mailbox_id, folder_id) REFERENCES folders(mailbox_id, id)
);
CREATE INDEX emails_folder_date ON emails(mailbox_id, folder_id, date DESC);
CREATE INDEX emails_thread ON emails(mailbox_id, thread_id, date);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  mailbox_id text NOT NULL,
  email_id uuid NOT NULL,
  filename text NOT NULL,
  mimetype text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  storage_key text NOT NULL,
  FOREIGN KEY (mailbox_id, email_id) REFERENCES emails(mailbox_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE emails IS 'Synthetic prototype mail. Simulated outbound messages are never delivered.';

CREATE TABLE inbox_members (
 email text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@realadvisor[.]com$'),
 role text NOT NULL CHECK (role IN ('admin','user')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_by text NOT NULL
);
CREATE TABLE inbox_member_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 email text NOT NULL,
 actor text NOT NULL,
 old_role text,
 new_role text,
 created_at timestamptz NOT NULL DEFAULT now()
);

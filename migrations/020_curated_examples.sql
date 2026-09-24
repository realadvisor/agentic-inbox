CREATE TABLE jev_examples (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 group_id uuid REFERENCES tag_groups(id) ON DELETE CASCADE,
 classifier_id uuid REFERENCES classifiers(id) ON DELETE CASCADE,
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('teach','test')),
 labels jsonb NOT NULL,
 note text NOT NULL DEFAULT '' CHECK(length(note)<=1000),
 state jsonb NOT NULL CHECK(octet_length(state::text)<=24000),
 config text NOT NULL,
 actor text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(num_nonnulls(group_id,classifier_id)=1),
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES conversations(mailbox_id,thread_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX jev_examples_group_thread ON jev_examples(group_id,mailbox_id,thread_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX jev_examples_classifier_thread ON jev_examples(classifier_id,mailbox_id,thread_id) WHERE classifier_id IS NOT NULL;

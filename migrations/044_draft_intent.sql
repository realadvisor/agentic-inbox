-- Nullable intent preserves compatibility with older application versions.
-- Legacy UUID links are retained as source context, never guessed as reply/forward.
ALTER TABLE emails ADD COLUMN draft_mode text CHECK (draft_mode IN ('new','reply','reply-all','forward'));
ALTER TABLE emails ADD COLUMN draft_source_id uuid;
UPDATE emails d SET draft_source_id=s.id FROM emails s
WHERE d.delivery_status='draft' AND d.mailbox_id=s.mailbox_id
AND d.in_reply_to=s.id::text AND s.delivery_status <> 'draft';
-- No FK: deleting a source must not delete or silently change the draft intent.

-- Offline import transactions opt out of automation and conversation reopening.
-- Normal ingestion keeps all existing triggers and constraints. The flag is set
-- with set_config(..., true), so it never leaks beyond an import transaction.
DO $$
DECLARE fn text; definition text; guarded text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['classifier_email_changed','enqueue_agent_draft','inbox_message_thread'] LOOP
    SELECT pg_get_functiondef(to_regprocedure(fn || '()')) INTO definition;
    IF definition IS NULL THEN RAISE EXCEPTION 'Missing import guard target: %', fn; END IF;
    IF strpos(definition, 'inbox.historical_import') > 0 THEN CONTINUE; END IF;
    guarded := regexp_replace(definition, E'\\mBEGIN\\M', E'BEGIN\n IF current_setting(''inbox.historical_import'', true) = ''on'' THEN RETURN NEW; END IF;');
    IF guarded = definition THEN RAISE EXCEPTION 'Cannot guard import target: %', fn; END IF;
    EXECUTE guarded;
  END LOOP;
END $$;

-- Suppress all outgoing webhooks during an import, including triggers introduced
-- by migration 028. The publisher sees no import event to deliver later.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef(to_regprocedure('emit_inbox_webhook(text,text,jsonb,text)')) INTO definition;
  IF definition IS NULL THEN RAISE EXCEPTION 'Missing webhook emitter'; END IF;
  IF strpos(definition, 'inbox.historical_import') = 0 THEN
    EXECUTE regexp_replace(definition, E'\\mBEGIN\\M', E'BEGIN\n IF current_setting(''inbox.historical_import'', true) = ''on'' THEN RETURN NULL; END IF;');
  END IF;
END $$;

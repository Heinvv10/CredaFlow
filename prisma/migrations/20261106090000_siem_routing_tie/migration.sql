-- audit_chain_append sends a row to the destination it was made under when the lender moved or stopped forwarding after it
-- was made: r."changedAt" > a."createdAt". Both are TIMESTAMP(3), so a row in the same millisecond as the change counted as made
-- after it, and with forwarding switched off it was queued nowhere. A tie now goes to the old destination: an audit row sent there
-- is on the record, and one lost is not. Only that comparison changes: the function is re-created from its own definition, so its
-- owner, grants, SECURITY DEFINER and SET clauses stay. Rows already chained are not revisited.
DO $body$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_functiondef('public.audit_chain_append(text, jsonb)'::regprocedure) INTO definition;
  changed := replace(definition, $sql$r."changedAt" > a."createdAt"$sql$, $sql$r."changedAt" >= a."createdAt"$sql$);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'audit_chain_append routing comparison shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

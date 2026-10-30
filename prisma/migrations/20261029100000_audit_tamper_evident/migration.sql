-- Tamper-evident audit (LPB tender spec 2.8.5, 4.7).
--
-- 1. AuditLog is append-only: UPDATE, DELETE and TRUNCATE are refused by
--    triggers, and the user/tenant foreign keys no longer SET NULL (that is an
--    UPDATE). The one exception is audit_log_redact(), below.
-- 2. AuditLog takes NO chain work on insert: no lock, no read of other rows. The
--    chainer (lib/audit/chainer.ts) appends one AuditChainLink per COMMITTED row,
--    so a rolled-back transaction, an ON CONFLICT skip or a Serializable
--    transaction never leaves or waits on a link. rowHash is an HMAC under a key
--    held outside the database (AUDIT_CHAIN_KEY), over keyed content digests the
--    worker computes, so a documented redaction (audit_log_redact) keeps the
--    chain verifiable and the database never holds an unkeyed digest of personal data.
-- 3. Links, checkpoints and redactions are insert-only. The outbox is the
--    lender's SIEM queue, filled by the chainer.
--
-- Adds enforcement: ships with the code (lib/audit/). The two AuditLog foreign
-- keys are added NOT VALID here and validated by the next migration, so the
-- table is not scanned under the DDL lock. Deploy requirement: the application's
-- database role must NOT own these tables (docs/ARCHITECTURE.md).

-- CreateEnum
CREATE TYPE "AuditSiemTransport" AS ENUM ('SYSLOG_TLS', 'HTTPS_JSON');

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_userId_fkey";

-- CreateTable
CREATE TABLE "AuditChainLink" (
    "chainKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "tenantId" TEXT,
    "prevHash" TEXT NOT NULL,
    "rowHash" TEXT NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditChainLink_pkey" PRIMARY KEY ("chainKey","seq")
);

-- CreateTable
CREATE TABLE "AuditChainCheckpoint" (
    "id" TEXT NOT NULL,
    "chainKey" TEXT NOT NULL,
    "tenantId" TEXT,
    "seq" INTEGER NOT NULL,
    "rowHash" TEXT NOT NULL,
    "hmac" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditChainCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRedaction" (
    "id" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL,
    "tenantId" TEXT,
    "columns" TEXT[],
    "userEmailDigest" TEXT NOT NULL,
    "ipAddressDigest" TEXT NOT NULL,
    "oldValueDigest" TEXT NOT NULL,
    "newValueDigest" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditRedaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "retentionMonths" INTEGER NOT NULL DEFAULT 12,
    "hotMonths" INTEGER NOT NULL DEFAULT 3,
    "siemEnabled" BOOLEAN NOT NULL DEFAULT false,
    "siemTransport" "AuditSiemTransport" NOT NULL DEFAULT 'HTTPS_JSON',
    "siemHost" TEXT,
    "siemPort" INTEGER,
    "siemUrl" TEXT,
    "siemSealedToken" TEXT,
    "siemCaCertPem" TEXT,
    "siemClientCert" TEXT,
    "siemSealedKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditSiemOutbox" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "auditLogId" TEXT,
    "checkpointId" TEXT,
    "seq" INTEGER,
    "targetSnapshot" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "deadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditSiemOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditChainRepair" (
    "id" TEXT NOT NULL,
    "chainKey" TEXT NOT NULL,
    "tenantId" TEXT,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "auditLogId" TEXT NOT NULL DEFAULT '',
    "linkRowHash" TEXT NOT NULL DEFAULT '',
    "observedHash" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "hmac" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditChainRepair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditChainMutex" (
    "chainKey" TEXT NOT NULL,

    CONSTRAINT "AuditChainMutex_pkey" PRIMARY KEY ("chainKey")
);

-- CreateTable
CREATE TABLE "AuditPolicyRevision" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "txid" BIGINT NOT NULL,
    "oldEnabled" BOOLEAN NOT NULL,
    "newEnabled" BOOLEAN NOT NULL,
    "rerouted" BOOLEAN NOT NULL,
    "oldSnapshot" JSONB NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditPolicyRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditSiemDelivery" (
    "id" SERIAL NOT NULL,
    "outboxId" INTEGER NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seq" INTEGER,
    "destination" TEXT NOT NULL,
    "ackId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditSiemDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditChainRepair_chainKey_seq_idx" ON "AuditChainRepair"("chainKey", "seq");

-- CreateIndex
CREATE INDEX "AuditPolicyRevision_tenantId_changedAt_idx" ON "AuditPolicyRevision"("tenantId", "changedAt");

-- CreateIndex
CREATE INDEX "AuditSiemDelivery_tenantId_outboxId_idx" ON "AuditSiemDelivery"("tenantId", "outboxId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditChainLink_auditLogId_key" ON "AuditChainLink"("auditLogId");

-- CreateIndex
CREATE INDEX "AuditChainCheckpoint_chainKey_seq_idx" ON "AuditChainCheckpoint"("chainKey", "seq");

-- CreateIndex
CREATE INDEX "AuditRedaction_auditLogId_idx" ON "AuditRedaction"("auditLogId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditPolicy_tenantId_key" ON "AuditPolicy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditSiemOutbox_auditLogId_key" ON "AuditSiemOutbox"("auditLogId");

-- CreateIndex
CREATE INDEX "AuditSiemOutbox_sentAt_idx" ON "AuditSiemOutbox"("sentAt");

-- (The AuditLog ("tenantId", "createdAt") index is created CONCURRENTLY by the next-but-one
-- migration, 20261029100050_audit_log_tenant_created_index, so a real book is not locked.)

-- AddForeignKey
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- ── Hand-written: bounds on the text columns of AuditLog ────────────────────
-- The chainer and the SIEM read every row, and a text column of hundreds of MB (it compresses to a few MB on disk)
-- would make its chain unlinkable for good, because a row cannot be skipped without breaking the chain's
-- continuity. The insert trigger CLIPS id, action, entity, entityId, userEmail and ipAddress to these limits (a
-- rejected insert would let whoever the row is about choose to leave no audit row); this CHECK is the backstop for
-- a row that bypasses the trigger, and holds ids (a cuid is 25 bytes) to 256. Generous limits no real writer comes
-- near. NOT VALID: new and updated rows are held to it, and the existing rows are not
-- scanned here (audit_hash_inputs hashes each text column in the database, so an old oversized one is still safe).
-- To validate once you have looked: SELECT count(*) FROM "AuditLog" WHERE NOT (<the condition>) and then
-- ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_text_bounded".
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_text_bounded" CHECK (
  octet_length("id") <= 256
  AND ("tenantId" IS NULL OR octet_length("tenantId") <= 256)
  AND ("userId" IS NULL OR octet_length("userId") <= 256)
  AND octet_length("action") <= 1024
  AND octet_length("entity") <= 1024
  AND ("entityId" IS NULL OR octet_length("entityId") <= 1024)
  AND ("userEmail" IS NULL OR octet_length("userEmail") <= 1024)
  AND ("ipAddress" IS NULL OR octet_length("ipAddress") <= 64)
) NOT VALID;

-- ── Hand-written: policy checks ─────────────────────────────────────────────

ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_retention_floor" CHECK ("retentionMonths" >= 12);
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_hot_window" CHECK ("hotMonths" >= 3 AND "hotMonths" <= "retentionMonths");
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_siem_target" CHECK (
  NOT "siemEnabled"
  OR ("siemTransport" = 'SYSLOG_TLS' AND "siemHost" IS NOT NULL AND "siemPort" BETWEEN 1 AND 65535)
  OR ("siemTransport" = 'HTTPS_JSON' AND "siemUrl" LIKE 'https://%')
);
-- A SIEM URL carries no backslash, whitespace or control character: WHATWG URL parsing and a regex
-- disagree about those, and the audit row shows only the origin (audit_policy_save).
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_siem_url_clean" CHECK ("siemUrl" IS NULL OR "siemUrl" !~ '[\\[:space:][:cntrl:]]');
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_siem_secrets_sealed" CHECK (
  ("siemSealedToken" IS NULL OR "siemSealedToken" LIKE 'enc:v1:%')
  AND ("siemSealedKey" IS NULL OR "siemSealedKey" LIKE 'enc:v1:%')
);
ALTER TABLE "AuditSiemOutbox" ADD CONSTRAINT "AuditSiemOutbox_kind" CHECK (
  ("kind" = 'EVENT' AND "auditLogId" IS NOT NULL)
  OR ("kind" = 'ANCHOR' AND "auditLogId" IS NULL AND "checkpointId" IS NULL)
  OR ("kind" = 'CHECKPOINT' AND "checkpointId" IS NOT NULL)
);

-- The next undelivered rows of a lender, in order.
CREATE INDEX "AuditSiemOutbox_pending_idx" ON "AuditSiemOutbox" ("tenantId", "id") WHERE "sentAt" IS NULL AND "deadAt" IS NULL;

-- ── Hand-written: append-only ───────────────────────────────────────────────

-- AuditLog: no UPDATE, DELETE or TRUNCATE. The only change a row may ever see is
-- audit_log_redact() (running as audit_redactor) setting userEmail, ipAddress,
-- oldValue or newValue to NULL, each only where an AuditRedaction row records the
-- digest of what was removed, with every other column untouched.
CREATE FUNCTION public.audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'audit_redactor' THEN
    IF NEW."id" = OLD."id"
       AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
       AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
       AND NEW."action" = OLD."action"
       AND NEW."entity" = OLD."entity"
       AND NEW."entityId" IS NOT DISTINCT FROM OLD."entityId"
       AND NEW."createdAt" = OLD."createdAt"
       AND (NEW."userEmail" IS NOT DISTINCT FROM OLD."userEmail"
            OR (NEW."userEmail" IS NULL AND EXISTS (SELECT 1 FROM "AuditRedaction" r WHERE r."auditLogId" = OLD."id" AND 'userEmail' = ANY(r."columns"))))
       AND (NEW."ipAddress" IS NOT DISTINCT FROM OLD."ipAddress"
            OR (NEW."ipAddress" IS NULL AND EXISTS (SELECT 1 FROM "AuditRedaction" r WHERE r."auditLogId" = OLD."id" AND 'ipAddress' = ANY(r."columns"))))
       AND (NEW."oldValue" IS NOT DISTINCT FROM OLD."oldValue"
            OR (NEW."oldValue" IS NULL AND EXISTS (SELECT 1 FROM "AuditRedaction" r WHERE r."auditLogId" = OLD."id" AND 'oldValue' = ANY(r."columns"))))
       AND (NEW."newValue" IS NOT DISTINCT FROM OLD."newValue"
            OR (NEW."newValue" IS NULL AND EXISTS (SELECT 1 FROM "AuditRedaction" r WHERE r."auditLogId" = OLD."id" AND 'newValue' = ANY(r."columns"))))
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'AuditLog is append-only: rows are never updated, deleted or truncated';
END;
$$;
-- "_a_" sorts before every other AuditLog trigger, so a refusal is the first word.
CREATE TRIGGER "AuditLog_a_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();
CREATE TRIGGER "AuditLog_a_append_only_truncate" BEFORE TRUNCATE ON "AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();

CREATE FUNCTION public.audit_log_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  clipped jsonb := '{}'::jsonb;
  n int;
BEGIN
  NEW."createdAt" := clock_timestamp();
  -- A value over 1 MB (as text) is replaced by a stub that says so, whoever wrote it: the chainer and the SIEM read
  -- every row, and a few hundred 30 MB values (cheap on disk: they compress) would stall them for every lender. No
  -- writer fails and none needs to know; the audit row still records what happened and how big the payload was.
  -- Always measured as text: a value copied in already compressed (INSERT ... SELECT from another table) is small as
  -- stored and huge as text, so a size check on the stored datum can be walked around.
  IF octet_length(NEW."oldValue"::text) > 1048576 THEN
    NEW."oldValue" := jsonb_build_object('truncated', true, 'bytes', octet_length(NEW."oldValue"::text));
  END IF;
  IF octet_length(NEW."newValue"::text) > 1048576 THEN
    NEW."newValue" := jsonb_build_object('truncated', true, 'bytes', octet_length(NEW."newValue"::text));
  END IF;

  -- The short text columns are CLIPPED, never rejected: userEmail (typed at a login), entityId (from a URL) and
  -- ipAddress (from a header) are chosen by whoever the audit row is about, and an insert that failed on them would
  -- let that party choose to leave no row at all. A prefix is kept with a marker that carries the original size (an
  -- ipAddress that long is no address, so it becomes 'invalid'), and newValue records the original size of each
  -- clipped column. id is clipped too; tenantId and userId are foreign keys, so a value that long matches no row anyway. (The CHECK AuditLog_text_bounded is the backstop for a row that
  -- bypasses this trigger.) left() counts characters; 200 of them are at most 800 bytes, plus the marker, under 1 KB.
  n := octet_length(NEW."action");
  IF n > 1024 THEN NEW."action" := left(NEW."action", 200) || '…[clipped ' || n || ' bytes]'; clipped := clipped || jsonb_build_object('action', n); END IF;
  n := octet_length(NEW."entity");
  IF n > 1024 THEN NEW."entity" := left(NEW."entity", 200) || '…[clipped ' || n || ' bytes]'; clipped := clipped || jsonb_build_object('entity', n); END IF;
  n := octet_length(NEW."entityId");
  IF n > 1024 THEN NEW."entityId" := left(NEW."entityId", 200) || '…[clipped ' || n || ' bytes]'; clipped := clipped || jsonb_build_object('entityId', n); END IF;
  n := octet_length(NEW."userEmail");
  IF n > 1024 THEN NEW."userEmail" := left(NEW."userEmail", 200) || '…[clipped ' || n || ' bytes]'; clipped := clipped || jsonb_build_object('userEmail', n); END IF;
  n := octet_length(NEW."ipAddress");
  IF n > 64 THEN NEW."ipAddress" := 'invalid'; clipped := clipped || jsonb_build_object('ipAddress', n); END IF;
  n := octet_length(NEW."id");
  IF n > 256 THEN NEW."id" := left(NEW."id", 100) || '…[clipped ' || n || ' bytes]'; clipped := clipped || jsonb_build_object('id', n); END IF;
  IF clipped <> '{}'::jsonb THEN
    IF NEW."newValue" IS NULL OR jsonb_typeof(NEW."newValue") = 'object' THEN
      NEW."newValue" := COALESCE(NEW."newValue", '{}'::jsonb) || jsonb_build_object('_clipped', clipped);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AuditLog_created_at" BEFORE INSERT ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.audit_log_created_at();

-- A lender's AuditPolicy row is never deleted: stopping forwarding is an UPDATE (siemEnabled =
-- false), which leaves a revision and routes the queued backlog. Deleting the row would hide both.
CREATE FUNCTION public.audit_policy_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'AuditPolicy is never deleted: switch forwarding off instead';
END;
$$;
CREATE TRIGGER "AuditPolicy_no_delete" BEFORE DELETE ON "AuditPolicy"
FOR EACH ROW EXECUTE FUNCTION public.audit_policy_no_delete();
CREATE TRIGGER "AuditPolicy_no_truncate" BEFORE TRUNCATE ON "AuditPolicy"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_policy_no_delete();

-- The evidence tables: no exception.
CREATE FUNCTION public.audit_evidence_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = format('%s is append-only: rows are never updated, deleted or truncated', TG_TABLE_NAME);
END;
$$;
CREATE TRIGGER "AuditChainLink_append_only" BEFORE UPDATE OR DELETE ON "AuditChainLink"
FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditChainLink_append_only_truncate" BEFORE TRUNCATE ON "AuditChainLink"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditChainCheckpoint_append_only" BEFORE UPDATE OR DELETE ON "AuditChainCheckpoint"
FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditChainCheckpoint_append_only_truncate" BEFORE TRUNCATE ON "AuditChainCheckpoint"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditRedaction_append_only" BEFORE UPDATE OR DELETE ON "AuditRedaction"
FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditRedaction_append_only_truncate" BEFORE TRUNCATE ON "AuditRedaction"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditChainRepair_append_only" BEFORE UPDATE OR DELETE ON "AuditChainRepair"
FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditChainRepair_append_only_truncate" BEFORE TRUNCATE ON "AuditChainRepair"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditPolicyRevision_append_only" BEFORE UPDATE OR DELETE ON "AuditPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditPolicyRevision_append_only_truncate" BEFORE TRUNCATE ON "AuditPolicyRevision"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_evidence_append_only();
-- A receipt for every batch row the SIEM acknowledged: a 'sent' mark with no receipt, or a
-- receipt the SIEM never saw, shows up when the two are compared.
CREATE TRIGGER "AuditSiemDelivery_append_only" BEFORE UPDATE OR DELETE ON "AuditSiemDelivery"
FOR EACH ROW EXECUTE FUNCTION public.audit_evidence_append_only();
CREATE TRIGGER "AuditSiemDelivery_append_only_truncate" BEFORE TRUNCATE ON "AuditSiemDelivery"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_evidence_append_only();

-- ── Hand-written: documented redaction (POPIA) ──────────────────────────────
-- Nulls personal data on one AuditLog row (a subset of userEmail, ipAddress,
-- oldValue, newValue), keeps the digests the row was chained with in
-- AuditRedaction so its link still verifies, and writes its own audit row. Not
-- callable by PUBLIC: grant EXECUTE only to the operator role that runs
-- scripts/audit-redact.ts. The application's role never gets it.

-- p_digests: {"<column>": "<64 hex>"} for each redacted column, the keyed digest (HMAC under
-- AUDIT_CHAIN_KEY) of the value being removed, computed by the operator tool
-- (scripts/audit-redact.ts) which holds the key. The database never computes or returns an
-- unkeyed digest of personal data; a wrong digest makes the row's link fail verification.
CREATE FUNCTION public.audit_log_redact(p_audit_log_id text, p_columns text[], p_reason text, p_operator text, p_digests jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  a "AuditLog";
  taken text[];
  c text;
BEGIN
  IF p_columns IS NULL OR cardinality(p_columns) = 0
     OR NOT (p_columns <@ ARRAY['userEmail', 'ipAddress', 'oldValue', 'newValue']) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_log_redact: columns must be a non-empty subset of userEmail, ipAddress, oldValue, newValue';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_log_redact: a reason of at least 10 characters is required';
  END IF;
  IF p_operator IS NULL OR btrim(p_operator) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_log_redact: the operator is required';
  END IF;
  SELECT * INTO a FROM "AuditLog" WHERE "id" = p_audit_log_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '02000', MESSAGE = 'audit_log_redact: no such audit row';
  END IF;
  SELECT COALESCE(array_agg(c2), ARRAY[]::text[]) INTO taken
  FROM "AuditRedaction" r, unnest(r."columns") AS c2 WHERE r."auditLogId" = p_audit_log_id;
  IF taken && p_columns THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_log_redact: a requested column is already redacted';
  END IF;
  FOREACH c IN ARRAY p_columns LOOP
    IF p_digests IS NULL OR COALESCE(p_digests->>c, '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('audit_log_redact: a keyed digest (64 hex) is required for %s', c);
    END IF;
  END LOOP;

  INSERT INTO "AuditRedaction" ("id", "auditLogId", "tenantId", "columns", "userEmailDigest", "ipAddressDigest", "oldValueDigest", "newValueDigest", "reason", "operator")
  VALUES (
    'red_' || replace(gen_random_uuid()::text, '-', ''), a."id", a."tenantId", p_columns,
    COALESCE(p_digests->>'userEmail', '-'), COALESCE(p_digests->>'ipAddress', '-'),
    COALESCE(p_digests->>'oldValue', '-'), COALESCE(p_digests->>'newValue', '-'),
    btrim(p_reason), btrim(p_operator));

  UPDATE "AuditLog" SET
    "userEmail" = CASE WHEN 'userEmail' = ANY(p_columns) THEN NULL ELSE "userEmail" END,
    "ipAddress" = CASE WHEN 'ipAddress' = ANY(p_columns) THEN NULL ELSE "ipAddress" END,
    "oldValue" = CASE WHEN 'oldValue' = ANY(p_columns) THEN NULL ELSE "oldValue" END,
    "newValue" = CASE WHEN 'newValue' = ANY(p_columns) THEN NULL ELSE "newValue" END
  WHERE "id" = a."id";

  INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "newValue")
  VALUES (
    'aud_' || replace(gen_random_uuid()::text, '-', ''), a."tenantId", 'AUDIT_ROW_REDACTED', 'AuditLog', a."id",
    jsonb_build_object('columns', to_jsonb(p_columns), 'reason', btrim(p_reason), 'operator', btrim(p_operator),
                       'databaseRole', session_user::text, 'rowAction', a."action"));
END;
$$;
REVOKE ALL ON FUNCTION public.audit_log_redact(text, text[], text, text, jsonb) FROM PUBLIC;

-- ── Hand-written: row-level security ────────────────────────────────────────
-- Same policy as the tenant-scoped models (20261014130000_tenant_rls). The
-- chain tables carry a nullable tenantId (the platform chain has none), so a
-- tenant never sees those rows. Binds nothing until the application connects as
-- a role RLS binds (docs/ARCHITECTURE.md, RLS activation checklist).

ALTER TABLE "AuditPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditPolicy" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditSiemOutbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditSiemOutbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditSiemOutbox" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditChainLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditChainLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditChainLink" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditChainCheckpoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditChainCheckpoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditChainCheckpoint" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditRedaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditRedaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditRedaction" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditChainMutex" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditChainMutex" FORCE ROW LEVEL SECURITY;
CREATE POLICY "only_the_definer" ON "AuditChainMutex" USING (public.cf_rls_unrestricted()) WITH CHECK (public.cf_rls_unrestricted());

ALTER TABLE "AuditChainRepair" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditChainRepair" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditChainRepair" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditPolicyRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditPolicyRevision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditPolicyRevision" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

ALTER TABLE "AuditSiemDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditSiemDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditSiemDelivery" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- ── Hand-written: the application's only door to the evidence tables ────────
-- The application connects as a role that owns nothing and holds INSERT and
-- SELECT on "AuditLog" alone (audit_grant_runtime, below). It has NO privilege on
-- AuditChainLink, AuditChainCheckpoint, AuditRedaction or AuditSiemOutbox: the
-- chainer, the verifier and the SIEM delivery reach them through the SECURITY
-- DEFINER functions here, which run as the role that migrated (the audit owner)
-- and check what they are given (a link continues its chain, a checkpoint names a
-- real link). A compromised application can therefore not rewrite, drop or
-- backdate the evidence, and cannot switch a trigger off (it owns no table).
-- search_path is pinned; app.rls_bypass is set for the call only (the SET clause
-- is undone when the function returns), so the row-level-security policies of the
-- evidence tables, FORCEd on the owner, do not hide rows from these functions.
-- Not callable by PUBLIC: audit_grant_runtime() grants EXECUTE to the app role.

-- What the worker hashes of an AuditLog row: the ids and time, and the SHA-256 of EVERY text column (action,
-- entity, entityId and the personal-data columns; jsonb as canonical text), computed here so that a row with a
-- huge value, old or new, costs the worker nothing to receive and can always be linked, plus, per column, the keyed digest a documented redaction kept (non-NULL only
-- where the column was redacted). The worker (the only holder of AUDIT_CHAIN_KEY) turns each into the
-- keyed digest that enters the link; the database never stores the plain SHA-256.
CREATE FUNCTION public.audit_hash_inputs(a "AuditLog")
RETURNS TABLE ("auditLogId" text, "tenantId" text, "userId" text, "actionSha" text, "entitySha" text, "entityIdSha" text, "createdAt" text,
               "userEmailSha" text, "ipAddressSha" text, "oldValueSha" text, "newValueSha" text,
               "userEmailRed" text, "ipAddressRed" text, "oldValueRed" text, "newValueRed" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT a."id", a."tenantId", a."userId",
    encode(sha256(convert_to(a."action", 'UTF8')), 'hex'), encode(sha256(convert_to(a."entity", 'UTF8')), 'hex'), encode(sha256(convert_to(a."entityId", 'UTF8')), 'hex'),
    to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
    encode(sha256(convert_to(a."userEmail", 'UTF8')), 'hex'), encode(sha256(convert_to(a."ipAddress", 'UTF8')), 'hex'),
    encode(sha256(convert_to(a."oldValue"::text, 'UTF8')), 'hex'), encode(sha256(convert_to(a."newValue"::text, 'UTF8')), 'hex'),
    (SELECT r."userEmailDigest" FROM "AuditRedaction" r WHERE r."auditLogId" = a."id" AND 'userEmail' = ANY(r."columns") LIMIT 1),
    (SELECT r."ipAddressDigest" FROM "AuditRedaction" r WHERE r."auditLogId" = a."id" AND 'ipAddress' = ANY(r."columns") LIMIT 1),
    (SELECT r."oldValueDigest" FROM "AuditRedaction" r WHERE r."auditLogId" = a."id" AND 'oldValue' = ANY(r."columns") LIMIT 1),
    (SELECT r."newValueDigest" FROM "AuditRedaction" r WHERE r."auditLogId" = a."id" AND 'newValue' = ANY(r."columns") LIMIT 1)
$$;

-- The rows of one chain: p_key is a tenant id, '' the rows with no tenant.
CREATE FUNCTION public.audit_in_chain(p_key text, p_tenant_id text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_key = '' THEN p_tenant_id IS NULL ELSE p_tenant_id = p_key END
$$;

CREATE FUNCTION public.audit_chain_head(p_key text) RETURNS TABLE ("seq" int, "rowHash" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT l."seq", l."rowHash" FROM "AuditChainLink" l WHERE l."chainKey" = p_key ORDER BY l."seq" DESC LIMIT 1
$$;

-- The newest createdAt among a chain's last 1000 linked rows: its high-water mark. Rows made after the
-- mark are scanned for cheaply; a row that committed long after it was made (a long transaction) can sit
-- behind it, which the deep pass finds (seven days back) and the full sweep (everything, daily).
CREATE FUNCTION public.audit_chain_floor(p_key text) RETURNS timestamp
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT max(a."createdAt") FROM (
    SELECT l."auditLogId" FROM "AuditChainLink" l WHERE l."chainKey" = p_key ORDER BY l."seq" DESC LIMIT 1000
  ) x JOIN "AuditLog" a ON a."id" = x."auditLogId"
$$;

-- Where a pass of the given mode starts looking: NULL (no floor) while the chain has no link (it is chained
-- from its first row) and for the full sweep; seven days back for the deep pass; otherwise the high-water mark
-- less a margin, but never further back than the 5000th newest linked row (a dense hour is not rescanned).
CREATE FUNCTION public.audit_chain_scan_floor(p_key text, p_mode text, p_margin_seconds int) RETURNS timestamp
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  hw timestamp;
  floor_at timestamp;
  cap timestamp;
BEGIN
  IF p_mode NOT IN ('shallow', 'deep', 'full') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit: the chainer mode is shallow, deep or full';
  END IF;
  IF p_mode = 'full' THEN
    RETURN NULL;
  END IF;
  hw := public.audit_chain_floor(p_key);
  IF hw IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_mode = 'deep' THEN
    RETURN now() - interval '7 days';
  END IF;
  floor_at := hw - make_interval(secs => p_margin_seconds);
  SELECT min(a."createdAt") INTO cap FROM (
    SELECT l."auditLogId" FROM "AuditChainLink" l WHERE l."chainKey" = p_key ORDER BY l."seq" DESC LIMIT 5000
  ) x JOIN "AuditLog" a ON a."id" = x."auditLogId";
  RETURN GREATEST(floor_at, cap);
END;
$$;

-- Chains with committed rows that have no link, looking where a pass of this mode looks. It also makes sure each
-- returned chain has its row in AuditChainMutex, committed on its own (this call is not inside the chainer's
-- transaction), so the chainer's lock never has to create it and wait on another chainer's uncommitted insert.
CREATE FUNCTION public.audit_chain_candidates(p_mode text, p_margin_seconds int) RETURNS SETOF text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  k text;
  floor_at timestamp;
BEGIN
  FOR k IN SELECT t."id" FROM "Tenant" t UNION SELECT '' LOOP
    floor_at := public.audit_chain_scan_floor(k, p_mode, p_margin_seconds);
    IF EXISTS (
      SELECT 1 FROM "AuditLog" a
      WHERE public.audit_in_chain(k, a."tenantId") AND (floor_at IS NULL OR a."createdAt" >= floor_at)
        AND NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = a."id")
    ) THEN
      INSERT INTO "AuditChainMutex" ("chainKey") VALUES (k) ON CONFLICT DO NOTHING;
      RETURN NEXT k;
    END IF;
  END LOOP;
END;
$$;

-- The oldest committed rows of a chain that have no link, with what the worker hashes of each, looking
-- where a pass of this mode looks (audit_chain_scan_floor): a backfill then continues from the mark, not
-- from the start, so it is not quadratic.
CREATE FUNCTION public.audit_chain_unlinked(p_key text, p_mode text, p_margin_seconds int, p_limit int)
RETURNS TABLE ("auditLogId" text, "tenantId" text, "userId" text, "actionSha" text, "entitySha" text, "entityIdSha" text, "createdAt" text,
               "userEmailSha" text, "ipAddressSha" text, "oldValueSha" text, "newValueSha" text,
               "userEmailRed" text, "ipAddressRed" text, "oldValueRed" text, "newValueRed" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  floor_at timestamp := public.audit_chain_scan_floor(p_key, p_mode, p_margin_seconds);
BEGIN
  RETURN QUERY
  SELECT h.* FROM (
    SELECT a FROM "AuditLog" a
    WHERE public.audit_in_chain(p_key, a."tenantId") AND (floor_at IS NULL OR a."createdAt" >= floor_at)
      AND NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = a."id")
    ORDER BY a."createdAt", a."id" LIMIT p_limit
  ) x, LATERAL public.audit_hash_inputs(x.a) h
  ORDER BY h."createdAt", h."auditLogId";
END;
$$;

-- The chain's mutual exclusion: the chainer calls this first in its transaction. A row of AuditChainMutex per
-- chain is locked FOR UPDATE SKIP LOCKED until that transaction ends, so a second chainer skips the chain. A
-- table only this function can touch, not an advisory lock, which any login could take to starve the chainer.
CREATE FUNCTION public.audit_chain_lock(p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
BEGIN
  INSERT INTO "AuditChainMutex" ("chainKey") VALUES (p_key) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM "AuditChainMutex" m WHERE m."chainKey" = p_key FOR UPDATE SKIP LOCKED;
  RETURN FOUND;
END;
$$;

-- Appends links to a chain. p_links: [{"seq", "auditLogId", "prevHash", "rowHash"}...] in
-- order. It must continue the chain (the first seq is head + 1 and its prevHash is
-- the head's rowHash, or 64 zeros for a new chain) and each link must name an
-- AuditLog row of that chain. Queues the rows for the lender's SIEM while it
-- forwards. Returns the links written.
CREATE FUNCTION public.audit_chain_append(p_key text, p_links jsonb) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  head_seq int;
  head_hash text;
  expect_seq int;
  expect_prev text;
  l record;
  snap jsonb;
  n int := 0;
BEGIN
  SELECT h."seq", h."rowHash" INTO head_seq, head_hash FROM public.audit_chain_head(p_key) h;
  expect_seq := COALESCE(head_seq, 0) + 1;
  expect_prev := COALESCE(head_hash, repeat('0', 64));
  FOR l IN SELECT * FROM jsonb_to_recordset(p_links) AS x("seq" int, "auditLogId" text, "prevHash" text, "rowHash" text) LOOP
    IF l."seq" IS DISTINCT FROM expect_seq OR l."prevHash" IS DISTINCT FROM expect_prev THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_chain_append: the link does not continue the chain';
    END IF;
    IF l."rowHash" IS NULL OR l."rowHash" !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_chain_append: malformed rowHash';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."id" = l."auditLogId" AND public.audit_in_chain(p_key, a."tenantId")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_chain_append: the link names no audit row of this chain';
    END IF;
    snap := NULL;
    INSERT INTO "AuditChainLink" ("chainKey", "seq", "auditLogId", "tenantId", "prevHash", "rowHash")
    VALUES (p_key, l."seq", l."auditLogId", NULLIF(p_key, ''), l."prevHash", l."rowHash");
    IF p_key <> '' THEN
      -- A row created before the lender moved or stopped forwarding belongs to the destination it
      -- was made under, even if it is chained after the change: stamp it with that snapshot.
      -- (AuditSiemOutbox_pending rows queued at the change itself were stamped by the policy trigger.)
      SELECT r."oldSnapshot" INTO snap FROM "AuditPolicyRevision" r JOIN "AuditLog" a ON a."id" = l."auditLogId"
      WHERE r."tenantId" = p_key AND r."oldEnabled" AND r."rerouted" AND r."changedAt" > a."createdAt"
      ORDER BY r."id" LIMIT 1;
      IF snap IS NOT NULL OR EXISTS (SELECT 1 FROM "AuditPolicy" p WHERE p."tenantId" = p_key AND p."siemEnabled") THEN
        -- ON CONFLICT: a policy-change row may already be queued for its old destination.
        INSERT INTO "AuditSiemOutbox" ("tenantId", "kind", "auditLogId", "seq", "targetSnapshot") VALUES (p_key, 'EVENT', l."auditLogId", l."seq", snap)
        ON CONFLICT ("auditLogId") DO NOTHING;
      END IF;
    END IF;
    expect_seq := l."seq" + 1;
    expect_prev := l."rowHash";
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- Records a signed checkpoint of a chain's link at p_seq (which must exist with
-- that hash and be newer than the chain's last checkpoint) and queues it for the
-- SIEM. Returns false when there is nothing new to record.
CREATE FUNCTION public.audit_checkpoint_write(p_key text, p_seq int, p_row_hash text, p_hmac text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  cp_id text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."chainKey" = p_key AND l."seq" = p_seq AND l."rowHash" = p_row_hash) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_checkpoint_write: no such link';
  END IF;
  IF p_hmac IS NULL OR p_hmac !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_checkpoint_write: malformed hmac';
  END IF;
  IF EXISTS (SELECT 1 FROM "AuditChainCheckpoint" c WHERE c."chainKey" = p_key AND c."seq" >= p_seq) THEN
    RETURN false;
  END IF;
  cp_id := 'cp_' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO "AuditChainCheckpoint" ("id", "chainKey", "tenantId", "seq", "rowHash", "hmac")
  VALUES (cp_id, p_key, NULLIF(p_key, ''), p_seq, p_row_hash, p_hmac);
  IF p_key <> '' THEN
    INSERT INTO "AuditSiemOutbox" ("tenantId", "kind", "checkpointId", "seq")
    SELECT p_key, 'CHECKPOINT', cp_id, p_seq FROM "AuditPolicy" p WHERE p."tenantId" = p_key AND p."siemEnabled";
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION public.audit_checkpoints(p_key text) RETURNS TABLE ("id" text, "seq" int, "rowHash" text, "hmac" text, "createdAt" timestamp)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT c."id", c."seq", c."rowHash", c."hmac", c."createdAt" FROM "AuditChainCheckpoint" c WHERE c."chainKey" = p_key ORDER BY c."seq"
$$;

CREATE FUNCTION public.audit_checkpoint_get(p_id text) RETURNS TABLE ("id" text, "seq" int, "rowHash" text, "hmac" text, "createdAt" timestamp)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT c."id", c."seq", c."rowHash", c."hmac", c."createdAt" FROM "AuditChainCheckpoint" c WHERE c."id" = p_id
$$;

CREATE FUNCTION public.audit_link_hash_at(p_key text, p_seq int) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT l."rowHash" FROM "AuditChainLink" l WHERE l."chainKey" = p_key AND l."seq" = p_seq
$$;

-- A page of a chain's links after p_after, each with what the worker hashes of the AuditLog
-- row it names (present = false when that row is gone).
CREATE FUNCTION public.audit_verify_links(p_key text, p_after int, p_limit int)
RETURNS TABLE ("seq" int, "linkAuditLogId" text, "prevHash" text, "rowHash" text, "present" boolean,
               "auditLogId" text, "tenantId" text, "userId" text, "actionSha" text, "entitySha" text, "entityIdSha" text, "createdAt" text,
               "userEmailSha" text, "ipAddressSha" text, "oldValueSha" text, "newValueSha" text,
               "userEmailRed" text, "ipAddressRed" text, "oldValueRed" text, "newValueRed" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT p."seq", p."auditLogId", p."prevHash", p."rowHash", (p."row")."id" IS NOT NULL,
         h."auditLogId", h."tenantId", h."userId", h."actionSha", h."entitySha", h."entityIdSha", h."createdAt",
         h."userEmailSha", h."ipAddressSha", h."oldValueSha", h."newValueSha",
         h."userEmailRed", h."ipAddressRed", h."oldValueRed", h."newValueRed"
  FROM (
    SELECT l."seq", l."auditLogId", l."prevHash", l."rowHash", a AS "row"
    FROM "AuditChainLink" l LEFT JOIN "AuditLog" a ON a."id" = l."auditLogId"
    WHERE l."chainKey" = p_key AND l."seq" > p_after ORDER BY l."seq" LIMIT p_limit
  ) p LEFT JOIN LATERAL public.audit_hash_inputs(p."row") h ON (p."row")."id" IS NOT NULL
  ORDER BY p."seq"
$$;

-- The id of one row of the chain older than p_cutoff that has no link, or NULL. No lower bound:
-- a break in the evidence must be found wherever it is.
CREATE FUNCTION public.audit_unchained_old(p_key text, p_cutoff timestamp) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT a."id" FROM "AuditLog" a
  WHERE public.audit_in_chain(p_key, a."tenantId") AND a."createdAt" < p_cutoff
    AND NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = a."id") LIMIT 1
$$;

CREATE FUNCTION public.audit_require_tenant(p_tenant text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_tenant IS NULL OR p_tenant = '' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit: a lender is required (the platform chain is not the web login''s to read or change)';
  END IF;
  IF public.cf_rls_tenant() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit: this session is not bound to a lender (app.tenant_id)';
  END IF;
  IF public.cf_rls_tenant() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit: this session is bound to another lender';
  END IF;
END;
$$;

-- What the web login may see of a chain: how far it is chained and the latest checkpoint (no hashes).
CREATE FUNCTION public.audit_chain_status(p_key text) RETURNS TABLE ("headSeq" int, "checkpointSeq" int, "checkpointAt" timestamp)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
BEGIN
  PERFORM public.audit_require_tenant(p_key);
  RETURN QUERY SELECT COALESCE((SELECT max(l."seq") FROM "AuditChainLink" l WHERE l."chainKey" = p_key), 0),
         (SELECT c."seq" FROM "AuditChainCheckpoint" c WHERE c."chainKey" = p_key ORDER BY c."seq" DESC LIMIT 1),
         (SELECT c."createdAt" FROM "AuditChainCheckpoint" c WHERE c."chainKey" = p_key ORDER BY c."seq" DESC LIMIT 1);
END;
$$;

-- The operator-accepted breaks of a chain (see audit_chain_accept_break).
CREATE FUNCTION public.audit_chain_repairs(p_key text)
RETURNS TABLE ("id" text, "seq" int, "kind" text, "auditLogId" text, "linkRowHash" text, "observedHash" text, "reason" text, "operator" text, "hmac" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT r."id", r."seq", r."kind", r."auditLogId", r."linkRowHash", r."observedHash", r."reason", r."operator", r."hmac"
  FROM "AuditChainRepair" r WHERE r."chainKey" = p_key ORDER BY r."seq", r."createdAt"
$$;

-- An operator accepts ONE break the verifier reported at link p_seq of a chain: a link lost to a restore, a
-- redaction made wrongly. The acceptance names exactly what was seen (the audit row, the link's hash and, for
-- a content mismatch, the hash the row recomputes to now) and is signed by the caller (HMAC under
-- AUDIT_CHAIN_KEY), which the verifier checks: a repair without the key is ignored, and the same row edited
-- again after the acceptance is a new break. It writes its own audit row. Operator role only.
CREATE FUNCTION public.audit_chain_accept_break(p_key text, p_seq int, p_kind text, p_audit_log_id text, p_link_hash text, p_observed text,
                                                p_reason text, p_operator text, p_hmac text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_chain_accept_break: a reason of at least 10 characters is required';
  END IF;
  IF p_operator IS NULL OR btrim(p_operator) = '' OR p_kind IS NULL OR btrim(p_kind) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_chain_accept_break: the operator and the kind are required';
  END IF;
  IF p_hmac IS NULL OR p_hmac !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_chain_accept_break: the signature is missing';
  END IF;
  IF COALESCE(p_link_hash, '') <> '' AND NOT EXISTS (
    SELECT 1 FROM "AuditChainLink" l WHERE l."chainKey" = p_key AND l."seq" = p_seq AND l."rowHash" = p_link_hash AND l."auditLogId" = COALESCE(p_audit_log_id, '')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_chain_accept_break: no such link';
  END IF;
  INSERT INTO "AuditChainRepair" ("id", "chainKey", "tenantId", "seq", "kind", "auditLogId", "linkRowHash", "observedHash", "reason", "operator", "hmac")
  VALUES ('rp_' || replace(gen_random_uuid()::text, '-', ''), p_key, NULLIF(p_key, ''), p_seq, btrim(p_kind), COALESCE(p_audit_log_id, ''), COALESCE(p_link_hash, ''),
          COALESCE(p_observed, ''), btrim(p_reason), btrim(p_operator), p_hmac);
  INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "newValue")
  VALUES ('aud_' || replace(gen_random_uuid()::text, '-', ''), NULLIF(p_key, ''), 'AUDIT_CHAIN_BREAK_ACCEPTED', 'AuditLog',
          jsonb_build_object('seq', p_seq, 'kind', btrim(p_kind), 'operator', btrim(p_operator), 'databaseRole', session_user::text));
END;
$$;

-- How many rows newer than p_cutoff the chainer has not linked yet (counted up to p_cap).
CREATE FUNCTION public.audit_unchained_pending(p_key text, p_cutoff timestamp, p_cap int) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT count(*)::int FROM (
    SELECT 1 FROM "AuditLog" a
    WHERE public.audit_in_chain(p_key, a."tenantId") AND a."createdAt" >= p_cutoff
      AND NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = a."id") LIMIT p_cap) p
$$;

-- ── SIEM outbox ──

CREATE FUNCTION public.audit_outbox_due_tenants(p_now timestamp) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT DISTINCT o."tenantId" FROM "AuditSiemOutbox" o WHERE o."sentAt" IS NULL AND o."deadAt" IS NULL AND o."nextAttemptAt" <= p_now
$$;

-- Rows bound for a destination the lender moved away from (each carries its own
-- target) whose audit row is chained, oldest first, due or not (the caller holds
-- everything behind a row that is backing off).
CREATE FUNCTION public.audit_outbox_snapshot_rows(p_tenant text, p_limit int)
RETURNS TABLE ("id" int, "kind" text, "auditLogId" text, "checkpointId" text, "seq" int, "targetSnapshot" jsonb, "attempts" int, "nextAttemptAt" timestamp, "createdAt" timestamp)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT o."id", o."kind", o."auditLogId", o."checkpointId", o."seq", o."targetSnapshot", o."attempts", o."nextAttemptAt", o."createdAt"
  FROM "AuditSiemOutbox" o
  WHERE o."tenantId" = p_tenant AND o."sentAt" IS NULL AND o."deadAt" IS NULL AND o."targetSnapshot" IS NOT NULL
    AND (o."auditLogId" IS NULL OR EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = o."auditLogId"))
  ORDER BY o."id" LIMIT p_limit
$$;

-- The lender's current stream, in order, due or not (the caller holds everything
-- behind a row that is backing off). Only chained rows.
CREATE FUNCTION public.audit_outbox_stream_rows(p_tenant text, p_limit int)
RETURNS TABLE ("id" int, "kind" text, "auditLogId" text, "checkpointId" text, "seq" int, "targetSnapshot" jsonb, "attempts" int, "nextAttemptAt" timestamp, "createdAt" timestamp)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT o."id", o."kind", o."auditLogId", o."checkpointId", o."seq", o."targetSnapshot", o."attempts", o."nextAttemptAt", o."createdAt"
  FROM "AuditSiemOutbox" o
  WHERE o."tenantId" = p_tenant AND o."sentAt" IS NULL AND o."deadAt" IS NULL AND o."targetSnapshot" IS NULL
    AND (o."auditLogId" IS NULL OR EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = o."auditLogId"))
  ORDER BY o."id" LIMIT p_limit
$$;

-- The audit rows and links behind queued events. A value larger than 64 KB is replaced by a stub saying so
-- (the SIEM sends values only for a few configuration actions, and bounded memory matters more than a huge value).
CREATE FUNCTION public.audit_outbox_sources(p_ids text[])
RETURNS TABLE ("id" text, "tenantId" text, "userId" text, "action" text, "entity" text, "entityId" text, "oldValue" jsonb, "newValue" jsonb,
               "ipAddress" text, "createdAt" timestamp, "linkSeq" int, "linkRowHash" text, "linkPrevHash" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT a."id", a."tenantId", a."userId", left(a."action", 1024), left(a."entity", 1024), left(a."entityId", 1024),
         CASE WHEN octet_length(a."oldValue"::text) > 65536 THEN jsonb_build_object('truncated', true, 'bytes', octet_length(a."oldValue"::text)) ELSE a."oldValue" END,
         CASE WHEN octet_length(a."newValue"::text) > 65536 THEN jsonb_build_object('truncated', true, 'bytes', octet_length(a."newValue"::text)) ELSE a."newValue" END,
         left(a."ipAddress", 64), a."createdAt", l."seq", l."rowHash", l."prevHash"
  FROM "AuditLog" a JOIN "AuditChainLink" l ON l."auditLogId" = a."id" WHERE a."id" = ANY(p_ids)
$$;

-- The target an outbox entry goes to: the snapshot it was stamped with when the lender moved away, else the lender's
-- current policy ('{}' when there is none).
CREATE FUNCTION public.audit_outbox_target(p_tenant text, p_snapshot jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT COALESCE(p_snapshot, (SELECT to_jsonb(p) FROM "AuditPolicy" p WHERE p."tenantId" = p_tenant), '{}'::jsonb)
$$;

-- A target as a receipt names it: a syslog host:port or an https origin, never a path, query or credential.
CREATE FUNCTION public.audit_destination(p_target jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(CASE p_target->>'siemTransport'
    WHEN 'SYSLOG_TLS' THEN 'syslog+tls://' || (p_target->>'siemHost') || ':' || (p_target->>'siemPort')
    ELSE substring(p_target->>'siemUrl' from '^(https://[^/?#\\[:space:][:cntrl:]]+)') END, 'unknown')
$$;

-- Marks entries of ONE lender after a delivery attempt, by the deliverer that holds the lender's lease. Only
-- that lender's still-pending entries whose backoff has elapsed can be marked (anything else raises), and only
-- in a way a delivery attempt can end:
--   'sent'  : the SIEM acknowledged the batch. Stamped with the database clock; a receipt per entry goes to
--             AuditSiemDelivery (append-only). The receipt's destination is the entry's OWN (the snapshot it was
--             stamped with when the lender moved away, else the lender's current policy), never the caller's word,
--             and the acknowledgement id is required when that destination is HTTPS (the transport falls back to
--             status + the answer's Date) and not for syslog (it has none). The ack is the worker's own statement of
--             what the SIEM said: reconcile it with the SIEM, it is not proof against a compromised worker.
--   'retry' : attempts + 1, next try at p_at: at least ~a minute ahead, and within two hours.
--   'dead'  : attempts + 1 and given up: only after three attempts, or when the AuditLog row (or checkpoint)
--             the entry names is really gone (p_error 'row_missing').
CREATE FUNCTION public.audit_outbox_mark(p_tenant text, p_holder text, p_ids int[], p_state text, p_error text, p_at timestamp, p_ack text DEFAULT NULL) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  n int;
  matched int;
BEGIN
  IF p_state NOT IN ('sent', 'retry', 'dead') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_outbox_mark: unknown state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AuditSiemLease" z WHERE z."tenantId" = p_tenant AND z."holder" = p_holder AND z."expiresAt" > now()) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_outbox_mark: the caller does not hold this lender''s delivery lease';
  END IF;
  SELECT count(*)::int INTO matched FROM "AuditSiemOutbox" o
  WHERE o."id" = ANY(p_ids) AND o."tenantId" = p_tenant AND o."sentAt" IS NULL AND o."deadAt" IS NULL;
  IF matched <> cardinality(p_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_outbox_mark: not all rows are this lender''s pending rows';
  END IF;
  -- nextAttemptAt is TIMESTAMP(3), which ROUNDS the default now() to the millisecond, up to half of one ahead of a
  -- now() read a moment later: a row marked within a millisecond of being queued would read as "backing off".
  IF EXISTS (SELECT 1 FROM "AuditSiemOutbox" o WHERE o."id" = ANY(p_ids) AND o."nextAttemptAt" > now() + interval '1 millisecond') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_outbox_mark: a row is still backing off';
  END IF;

  IF p_state = 'sent' THEN
    IF COALESCE(btrim(p_ack), '') = '' AND EXISTS (
      SELECT 1 FROM "AuditSiemOutbox" o
      WHERE o."id" = ANY(p_ids) AND COALESCE(public.audit_outbox_target(o."tenantId", o."targetSnapshot")->>'siemTransport', 'HTTPS_JSON') <> 'SYSLOG_TLS'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_outbox_mark: an HTTPS delivery carries the SIEM''s acknowledgement id';
    END IF;
    INSERT INTO "AuditSiemDelivery" ("outboxId", "tenantId", "kind", "seq", "destination", "ackId")
    SELECT o."id", o."tenantId", o."kind", o."seq",
           left(public.audit_destination(public.audit_outbox_target(o."tenantId", o."targetSnapshot")), 300), left(p_ack, 200)
    FROM "AuditSiemOutbox" o WHERE o."id" = ANY(p_ids);
    UPDATE "AuditSiemOutbox" SET "sentAt" = now(), "lastError" = NULL WHERE "id" = ANY(p_ids);
  ELSIF p_state = 'retry' THEN
    IF p_at IS NULL OR p_at < now() + interval '50 seconds' OR p_at > now() + interval '2 hours' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_outbox_mark: a retry is scheduled at least a minute ahead, within two hours';
    END IF;
    UPDATE "AuditSiemOutbox" SET "attempts" = "attempts" + 1, "nextAttemptAt" = p_at, "lastError" = left(p_error, 200) WHERE "id" = ANY(p_ids);
  ELSE
    IF p_error IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_outbox_mark: giving a row up needs a reason';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "AuditSiemOutbox" o
      WHERE o."id" = ANY(p_ids) AND o."attempts" + 1 < 3
        AND NOT (p_error = 'row_missing' AND (
          (o."kind" = 'EVENT' AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."id" = o."auditLogId"))
          OR (o."kind" = 'CHECKPOINT' AND NOT EXISTS (SELECT 1 FROM "AuditChainCheckpoint" c WHERE c."id" = o."checkpointId"))))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_outbox_mark: a row is not given up before three attempts';
    END IF;
    UPDATE "AuditSiemOutbox" SET "attempts" = "attempts" + 1, "deadAt" = now(), "lastError" = left(p_error, 200) WHERE "id" = ANY(p_ids);
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- The only way a lender's AuditPolicy changes: the web login has no DML on the table and calls
-- this. In one transaction it writes the policy, lets the AuditPolicy trigger record the
-- revision and stamp the queued backlog with the destination being left, inserts the
-- AUDIT_POLICY_UPDATED audit row ITSELF (so no caller can change a policy without that row, or
-- file one without the change), queues that row for the OLD destination and, if forwarding
-- starts at a new one, an anchor (the chain position at the change). The audit row records the
-- policy as an origin only, never a path or query (it may carry a key) or a secret.
-- p_data keys: retentionMonths, hotMonths, siemEnabled, siemTransport, siemHost, siemPort, siemUrl,
-- siemSealedToken, siemCaCertPem, siemClientCert, siemSealedKey (a JSON null clears one), plus the origin and
-- path-or-query flag of siemUrl as the application parsed them (siemOrigin, siemUrlHasPathOrQuery), which this
-- function checks against the URL it stores. A session bound to one lender can save only that lender's policy,
-- and the actor must be a user of that lender. Returns the policy id.
CREATE FUNCTION public.audit_policy_save(p_tenant text, p_data jsonb, p_actor_id text, p_actor_email text, p_ip text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  old "AuditPolicy";
  cur "AuditPolicy";
  had boolean;
  audit_id text := 'aud_' || replace(gen_random_uuid()::text, '-', '');
  rev "AuditPolicyRevision";
  url text;
  origin text;
BEGIN
  PERFORM public.audit_require_tenant(p_tenant);
  IF p_actor_id IS NULL OR NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = p_actor_id AND u."tenantId" = p_tenant) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit_policy_save: the actor must be a user of this lender';
  END IF;
  IF p_data->>'siemUrl' IS NOT NULL THEN
    url := p_data->>'siemUrl';
    origin := p_data->>'siemOrigin';
    IF url ~ '[\\[:space:][:cntrl:]]' OR origin IS NULL OR left(url, length(origin)) <> origin
       OR substring(url from length(origin) + 1) !~ '^([/?#]|$)'
       OR COALESCE((p_data->>'siemUrlHasPathOrQuery')::boolean, NOT (substring(url from length(origin) + 1) IN ('', '/'))) <> NOT (substring(url from length(origin) + 1) IN ('', '/')) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_policy_save: the SIEM URL and its origin disagree';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t."id" = p_tenant) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'audit_policy_save: no such lender';
  END IF;
  SELECT * INTO old FROM "AuditPolicy" p WHERE p."tenantId" = p_tenant FOR UPDATE;
  had := FOUND;

  INSERT INTO "AuditPolicy" ("id", "tenantId", "retentionMonths", "hotMonths", "siemEnabled", "siemTransport", "siemHost", "siemPort", "siemUrl",
                             "siemSealedToken", "siemCaCertPem", "siemClientCert", "siemSealedKey", "updatedAt")
  VALUES ('cap_' || replace(gen_random_uuid()::text, '-', ''), p_tenant,
          (p_data->>'retentionMonths')::int, (p_data->>'hotMonths')::int, (p_data->>'siemEnabled')::boolean,
          (p_data->>'siemTransport')::"AuditSiemTransport", p_data->>'siemHost', (p_data->>'siemPort')::int, p_data->>'siemUrl',
          p_data->>'siemSealedToken', p_data->>'siemCaCertPem', p_data->>'siemClientCert', p_data->>'siemSealedKey', now())
  ON CONFLICT ("tenantId") DO UPDATE SET
    "retentionMonths" = EXCLUDED."retentionMonths", "hotMonths" = EXCLUDED."hotMonths", "siemEnabled" = EXCLUDED."siemEnabled",
    "siemTransport" = EXCLUDED."siemTransport", "siemHost" = EXCLUDED."siemHost", "siemPort" = EXCLUDED."siemPort", "siemUrl" = EXCLUDED."siemUrl",
    "siemSealedToken" = EXCLUDED."siemSealedToken", "siemCaCertPem" = EXCLUDED."siemCaCertPem", "siemClientCert" = EXCLUDED."siemClientCert",
    "siemSealedKey" = EXCLUDED."siemSealedKey", "updatedAt" = now()
  RETURNING * INTO cur;

  INSERT INTO "AuditLog" ("id", "tenantId", "userId", "userEmail", "action", "entity", "entityId", "oldValue", "newValue", "ipAddress")
  VALUES (audit_id, p_tenant, p_actor_id, p_actor_email, 'AUDIT_POLICY_UPDATED', 'AuditPolicy', cur."id",
          CASE WHEN had THEN public.audit_policy_view(old) ELSE NULL END, public.audit_policy_view(cur, p_data->>'siemOrigin', (p_data->>'siemUrlHasPathOrQuery')::boolean), p_ip);

  SELECT * INTO rev FROM "AuditPolicyRevision" r WHERE r."tenantId" = p_tenant AND r."txid" = txid_current() ORDER BY r."id" DESC LIMIT 1;
  IF FOUND THEN
    IF rev."oldEnabled" THEN
      INSERT INTO "AuditSiemOutbox" ("tenantId", "kind", "auditLogId", "targetSnapshot") VALUES (p_tenant, 'EVENT', audit_id, rev."oldSnapshot")
      ON CONFLICT ("auditLogId") DO NOTHING;
    END IF;
    IF rev."newEnabled" AND rev."rerouted" THEN
      INSERT INTO "AuditSiemOutbox" ("tenantId", "kind", "seq")
      VALUES (p_tenant, 'ANCHOR', COALESCE((SELECT h."seq" FROM public.audit_chain_head(p_tenant) h), 0));
    END IF;
  END IF;
  RETURN cur."id";
END;
$$;

-- What the audit row of a policy change records: no secret, no certificate, and a URL as its origin only. The
-- application (which parses URLs the way a browser and a SIEM do) passes the origin and whether a path or query
-- is set; the regexes here are the backstop for a row the function did not write (they exclude a backslash,
-- whitespace and control characters, which the policy CHECK refuses anyway).
CREATE FUNCTION public.audit_policy_view(p "AuditPolicy", p_origin text DEFAULT NULL, p_has_path boolean DEFAULT NULL) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'retentionMonths', p."retentionMonths", 'hotMonths', p."hotMonths", 'siemEnabled', p."siemEnabled", 'siemTransport', p."siemTransport"::text,
    'siemHost', p."siemHost", 'siemPort', p."siemPort",
    'siemOrigin', COALESCE(p_origin, substring(p."siemUrl" from '^(https://[^/?#\\[:space:][:cntrl:]]+)')),
    'siemUrlHasPathOrQuery', COALESCE(p_has_path, COALESCE(p."siemUrl" ~ '^https://[^/?#\\[:space:][:cntrl:]]+(/[^?#]+|[?#])', false)),
    'siemTokenSet', p."siemSealedToken" IS NOT NULL, 'siemClientKeySet', p."siemSealedKey" IS NOT NULL)
$$;

-- AuditPolicy trigger: records what a change to the delivery settings left behind and, when
-- forwarding stops or moves, stamps everything still queued for the lender with the
-- destination being left, in the same transaction, so the backlog drains there in order
-- and is never pruned or redirected. A change to a credential or certificate alone (same
-- destination) is recorded but reroutes nothing.
CREATE FUNCTION public.audit_policy_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  old_enabled boolean := (TG_OP = 'UPDATE' AND OLD."siemEnabled");
  moved boolean;
  snap jsonb;
BEGIN
  IF NOT old_enabled AND NOT NEW."siemEnabled" THEN
    RETURN NEW;
  END IF;
  IF old_enabled AND NEW."siemEnabled"
     AND (NEW."siemTransport", NEW."siemHost", NEW."siemPort", NEW."siemUrl", NEW."siemSealedToken", NEW."siemCaCertPem", NEW."siemClientCert", NEW."siemSealedKey")
         IS NOT DISTINCT FROM
         (OLD."siemTransport", OLD."siemHost", OLD."siemPort", OLD."siemUrl", OLD."siemSealedToken", OLD."siemCaCertPem", OLD."siemClientCert", OLD."siemSealedKey") THEN
    RETURN NEW;
  END IF;
  moved := NOT old_enabled OR NOT NEW."siemEnabled"
           OR (NEW."siemTransport", NEW."siemHost", NEW."siemPort", NEW."siemUrl") IS DISTINCT FROM (OLD."siemTransport", OLD."siemHost", OLD."siemPort", OLD."siemUrl");
  snap := CASE WHEN old_enabled THEN jsonb_build_object(
      'siemTransport', OLD."siemTransport"::text, 'siemHost', OLD."siemHost", 'siemPort', OLD."siemPort", 'siemUrl', OLD."siemUrl",
      'siemSealedToken', OLD."siemSealedToken", 'siemCaCertPem', OLD."siemCaCertPem", 'siemClientCert', OLD."siemClientCert", 'siemSealedKey', OLD."siemSealedKey")
    ELSE '{}'::jsonb END;
  INSERT INTO "AuditPolicyRevision" ("tenantId", "txid", "oldEnabled", "newEnabled", "rerouted", "oldSnapshot", "changedAt")
  VALUES (NEW."tenantId", txid_current(), old_enabled, NEW."siemEnabled", moved, snap, clock_timestamp());
  IF old_enabled AND moved THEN
    UPDATE "AuditSiemOutbox" SET "targetSnapshot" = snap
    WHERE "tenantId" = NEW."tenantId" AND "sentAt" IS NULL AND "deadAt" IS NULL AND "targetSnapshot" IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AuditPolicy_revision" AFTER INSERT OR UPDATE ON "AuditPolicy"
FOR EACH ROW EXECUTE FUNCTION public.audit_policy_revision();

-- Forwarding is off for the lender: what is still queued for the current destination is
-- dropped, and the pruning is itself an audit row (with the count). Refuses while the lender
-- forwards, and when the policy row is gone while its history says forwarding was on (the row is
-- never deleted; if it is, that is not a switch-off). (A backlog from before a switch-off was
-- stamped by the policy trigger and is not touched here.)
CREATE FUNCTION public.audit_outbox_prune_unsent(p_tenant text) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  n int;
BEGIN
  IF EXISTS (SELECT 1 FROM "AuditPolicy" p WHERE p."tenantId" = p_tenant AND p."siemEnabled") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_outbox_prune_unsent: the lender is forwarding';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "AuditPolicy" p WHERE p."tenantId" = p_tenant)
     AND (SELECT r."newEnabled" FROM "AuditPolicyRevision" r WHERE r."tenantId" = p_tenant ORDER BY r."id" DESC LIMIT 1) IS TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'audit_outbox_prune_unsent: the policy row is gone while its history says forwarding was on';
  END IF;
  DELETE FROM "AuditSiemOutbox" WHERE "tenantId" = p_tenant AND "sentAt" IS NULL AND "deadAt" IS NULL AND "targetSnapshot" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "newValue")
    VALUES ('aud_' || replace(gen_random_uuid()::text, '-', ''), p_tenant, 'AUDIT_SIEM_QUEUE_PRUNED', 'AuditSiemOutbox', jsonb_build_object('pruned', n));
  END IF;
  RETURN n;
END;
$$;

-- Sent entries are kept seven days (the delivery receipts are kept for good).
CREATE FUNCTION public.audit_outbox_purge_sent() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  n int;
BEGIN
  DELETE FROM "AuditSiemOutbox" WHERE "sentAt" < now() - interval '7 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE FUNCTION public.audit_outbox_oldest_pending() RETURNS timestamp
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT o."createdAt" FROM "AuditSiemOutbox" o WHERE o."sentAt" IS NULL AND o."deadAt" IS NULL ORDER BY o."id" LIMIT 1
$$;

-- ── SIEM delivery lease ──
-- One deliverer per lender at a time, across processes, with no connection or transaction held
-- while it talks to the SIEM (a pooled client cannot keep a session lock): a lease row that
-- expires by itself, so a crashed deliverer does not block a lender for long.
CREATE TABLE "AuditSiemLease" (
    "tenantId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditSiemLease_pkey" PRIMARY KEY ("tenantId")
);
ALTER TABLE "AuditSiemLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditSiemLease" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "AuditSiemLease" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

CREATE FUNCTION public.audit_outbox_lease(p_tenant text, p_holder text, p_seconds int) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
DECLARE
  got text;
BEGIN
  IF p_seconds < 1 OR p_seconds > 3600 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_outbox_lease: a lease is 1 to 3600 seconds';
  END IF;
  INSERT INTO "AuditSiemLease" ("tenantId", "holder", "expiresAt") VALUES (p_tenant, p_holder, now() + make_interval(secs => p_seconds))
  ON CONFLICT ("tenantId") DO UPDATE SET "holder" = EXCLUDED."holder", "expiresAt" = EXCLUDED."expiresAt"
  WHERE "AuditSiemLease"."holder" = p_holder OR "AuditSiemLease"."expiresAt" <= now()
  RETURNING "holder" INTO got;
  RETURN got IS NOT NULL;
END;
$$;

CREATE FUNCTION public.audit_outbox_release(p_tenant text, p_holder text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  DELETE FROM "AuditSiemLease" WHERE "tenantId" = p_tenant AND "holder" = p_holder
$$;

-- The lender's AuditPolicy, read past row-level security.
CREATE FUNCTION public.audit_delivery_policy(p_tenant text) RETURNS SETOF "AuditPolicy"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET app.rls_bypass = 'on' AS $$
  SELECT * FROM "AuditPolicy" p WHERE p."tenantId" = p_tenant
$$;

-- ── Hand-written: privileges ────────────────────────────────────────────────
-- Three logins (docs/ARCHITECTURE.md): the OWNER migrates; the WEB login serves requests; the
-- WORKER login runs the chainer, the verifier and the SIEM delivery. Run by the owner once a
-- login exists (after migrate deploy, and again after any GRANT ... ON ALL TABLES it is given):
--   SELECT audit_grant_web('credaflow_web');
--   SELECT audit_grant_worker('credaflow_worker');
--   SELECT audit_grant_runtime('credaflow_app');   -- ONE login for both: single-process stacks
-- Each ends with INSERT and SELECT on "AuditLog", SELECT on "AuditPolicy" and EXECUTE on the
-- functions of its kind, and nothing on the evidence tables, the outbox, the sequences behind
-- them, or audit_log_redact() / audit_chain_accept_break(). The WEB login can neither chain, nor
-- sign a checkpoint, nor touch the outbox: it can call audit_policy_save and read a chain's status.
-- A login may not be a superuser, BYPASSRLS, CREATEROLE, CREATEDB, hold CREATE on the schema, own
-- a table, or be a MEMBER of a role that owns an audit table or audit_log_redact().

-- Refuses a role that could undo the audit protections.
CREATE FUNCTION public.audit_check_login_role(p_role text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  owner_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) THEN
    RAISE EXCEPTION USING ERRCODE = '42704', MESSAGE = format('audit: no role %s', p_role);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit: the role must not be a superuser, BYPASSRLS, CREATEROLE or CREATEDB';
  END IF;
  FOR owner_role IN
    SELECT DISTINCT t.tableowner FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename LIKE 'Audit%'
    UNION SELECT 'audit_redactor'
  LOOP
    IF pg_has_role(p_role, owner_role, 'MEMBER') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = format('audit: the role is, or is a member of, %s, which owns audit tables or the redaction function', owner_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = p_role) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit: the role owns tables; an owner can disable their triggers';
  END IF;
  IF has_schema_privilege(p_role, 'public', 'CREATE') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'audit: the role must not hold CREATE on schema public (REVOKE CREATE ON SCHEMA public FROM PUBLIC)';
  END IF;
END;
$$;

CREATE FUNCTION public.audit_grant_functions(p_role text, p_names text[]) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fn text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY(p_names) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, p_role);
  END LOOP;
END;
$$;

-- The common part: check the role, take back everything on the audit tables and the sequences
-- behind them, give the schema, INSERT/SELECT on the log and SELECT on the policy.
CREATE FUNCTION public.audit_grant_base(p_role text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.audit_check_login_role(p_role);
  EXECUTE format('REVOKE ALL ON TABLE "AuditLog", "AuditChainLink", "AuditChainCheckpoint", "AuditRedaction", "AuditSiemOutbox", "AuditPolicy", "AuditPolicyRevision", "AuditSiemDelivery", "AuditChainRepair", "AuditSiemLease", "AuditChainMutex" FROM %I', p_role);
  EXECUTE format('REVOKE ALL ON SEQUENCE "AuditSiemOutbox_id_seq", "AuditPolicyRevision_id_seq", "AuditSiemDelivery_id_seq" FROM %I', p_role);
  -- A transaction left open does not hold a chain's late commit back for long: the sweeps bound the rest.
  EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = ''15min''', p_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', p_role);
  EXECUTE format('GRANT INSERT, SELECT ON TABLE "AuditLog" TO %I', p_role);
  EXECUTE format('GRANT SELECT ON TABLE "AuditPolicy" TO %I', p_role);
END;
$$;

CREATE FUNCTION public.audit_grant_web(p_role text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.audit_grant_base(p_role);
  PERFORM public.audit_grant_functions(p_role, ARRAY['audit_policy_save', 'audit_chain_status']);
END;
$$;

CREATE FUNCTION public.audit_grant_worker(p_role text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.audit_grant_base(p_role);
  PERFORM public.audit_grant_functions(p_role, ARRAY[
    'audit_chain_head', 'audit_chain_candidates', 'audit_chain_unlinked', 'audit_chain_lock', 'audit_chain_append', 'audit_checkpoint_write',
    'audit_checkpoints', 'audit_checkpoint_get', 'audit_link_hash_at', 'audit_verify_links', 'audit_unchained_old',
    'audit_unchained_pending', 'audit_chain_repairs',
    'audit_outbox_due_tenants', 'audit_outbox_snapshot_rows', 'audit_outbox_stream_rows', 'audit_outbox_sources',
    'audit_outbox_mark', 'audit_outbox_prune_unsent', 'audit_outbox_purge_sent', 'audit_outbox_oldest_pending',
    'audit_outbox_lease', 'audit_outbox_release', 'audit_delivery_policy']);
END;
$$;

-- One login for both (a single-process stack: the app also runs the crons). Weaker: the web
-- process then holds the worker's functions. Separate logins are the supported production shape.
CREATE FUNCTION public.audit_grant_runtime(p_role text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.audit_grant_worker(p_role);
  PERFORM public.audit_grant_functions(p_role, ARRAY['audit_policy_save', 'audit_chain_status']);
END;
$$;

-- ── Hand-written: re-asserting the protections an ownership/ACL-free restore loses ──
-- The role that owns audit_log_redact(). A redaction is the only UPDATE AuditLog ever sees, and
-- the trigger lets it through only when it runs AS this role (the function is SECURITY DEFINER and
-- owned by it): a session setting is not an authority, a role is. It cannot log in and a login
-- must not be a member of it (the grants refuse that).
--
-- pg_restore --no-owner --no-acl (the backup, drill and demo restore paths) and a restore into a
-- NEW cluster (no such role yet) lose the function's owner, its privileges, and the REVOKE FROM
-- PUBLIC on every audit function. Run by the owner after any restore (the restore scripts do), and
-- here at the end of this migration: idempotent.
CREATE FUNCTION public.audit_reassert_protections() RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_redactor') THEN
    CREATE ROLE audit_redactor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  -- ALTER FUNCTION ... OWNER TO needs the acting role to be a member of the new owner.
  IF NOT pg_has_role(current_user, 'audit_redactor', 'MEMBER') THEN
    EXECUTE format('GRANT audit_redactor TO %I', current_user);
  END IF;
  GRANT CREATE ON SCHEMA public TO audit_redactor;
  ALTER FUNCTION public.audit_log_redact(text, text[], text, text, jsonb) OWNER TO audit_redactor;
  REVOKE CREATE ON SCHEMA public FROM audit_redactor;
  GRANT USAGE ON SCHEMA public TO audit_redactor;
  GRANT SELECT, INSERT ON TABLE "AuditLog" TO audit_redactor;
  GRANT UPDATE ("userEmail", "ipAddress", "oldValue", "newValue") ON TABLE "AuditLog" TO audit_redactor;
  GRANT SELECT, INSERT ON TABLE "AuditRedaction" TO audit_redactor;
  FOR fn IN
    SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'audit\_%' AND p.proname NOT IN ('audit_log_append_only', 'audit_evidence_append_only')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
  END LOOP;
END;
$$;
SELECT public.audit_reassert_protections();

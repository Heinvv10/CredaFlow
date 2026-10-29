-- Tamper-evident audit (LPB tender spec 2.8.5, 4.7).
--
-- 1. AuditLog is append-only: UPDATE, DELETE and TRUNCATE are refused by
--    triggers, and the user/tenant foreign keys no longer SET NULL (that is an
--    UPDATE). The one exception is audit_log_redact(), below.
-- 2. AuditLog takes NO chain work on insert: no lock, no read of other rows. The
--    chainer (lib/audit/chainer.ts) appends one AuditChainLink per COMMITTED row,
--    so a rolled-back transaction, an ON CONFLICT skip or a Serializable
--    transaction never leaves or waits on a link. rowHash is an HMAC under a key
--    held outside the database (AUDIT_CHAIN_KEY), over content digests, so a
--    documented redaction (audit_log_redact) keeps the chain verifiable.
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

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- ── Hand-written: policy checks ─────────────────────────────────────────────

ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_retention_floor" CHECK ("retentionMonths" >= 12);
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_hot_window" CHECK ("hotMonths" >= 3 AND "hotMonths" <= "retentionMonths");
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_siem_target" CHECK (
  NOT "siemEnabled"
  OR ("siemTransport" = 'SYSLOG_TLS' AND "siemHost" IS NOT NULL AND "siemPort" BETWEEN 1 AND 65535)
  OR ("siemTransport" = 'HTTPS_JSON' AND "siemUrl" LIKE 'https://%')
);
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
-- audit_log_redact() setting userEmail, ipAddress, oldValue or newValue to NULL,
-- with every other column untouched and the function's transaction-local flag on.
CREATE FUNCTION public.audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('cf.audit_redaction', true) = 'on'
       AND NEW."id" = OLD."id"
       AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
       AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
       AND NEW."action" = OLD."action"
       AND NEW."entity" = OLD."entity"
       AND NEW."entityId" IS NOT DISTINCT FROM OLD."entityId"
       AND NEW."createdAt" = OLD."createdAt"
       AND (NEW."userEmail" IS NULL OR NEW."userEmail" IS NOT DISTINCT FROM OLD."userEmail")
       AND (NEW."ipAddress" IS NULL OR NEW."ipAddress" IS NOT DISTINCT FROM OLD."ipAddress")
       AND (NEW."oldValue" IS NULL OR NEW."oldValue" IS NOT DISTINCT FROM OLD."oldValue")
       AND (NEW."newValue" IS NULL OR NEW."newValue" IS NOT DISTINCT FROM OLD."newValue")
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

-- ── Hand-written: documented redaction (POPIA) ──────────────────────────────
-- Nulls personal data on one AuditLog row (a subset of userEmail, ipAddress,
-- oldValue, newValue), keeps the digests the row was chained with in
-- AuditRedaction so its link still verifies, and writes its own audit row. Not
-- callable by PUBLIC: grant EXECUTE only to the operator role that runs
-- scripts/audit-redact.ts. The application's role never gets it.

CREATE FUNCTION public.audit_log_redact(p_audit_log_id text, p_columns text[], p_reason text, p_operator text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a "AuditLog";
  taken text[];
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
  SELECT COALESCE(array_agg(c), ARRAY[]::text[]) INTO taken
  FROM "AuditRedaction" r, unnest(r."columns") AS c WHERE r."auditLogId" = p_audit_log_id;
  IF taken && p_columns THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'audit_log_redact: a requested column is already redacted';
  END IF;

  INSERT INTO "AuditRedaction" ("id", "auditLogId", "tenantId", "columns", "userEmailDigest", "ipAddressDigest", "oldValueDigest", "newValueDigest", "reason", "operator")
  VALUES (
    'red_' || replace(gen_random_uuid()::text, '-', ''), a."id", a."tenantId", p_columns,
    COALESCE(encode(sha256(convert_to(a."userEmail", 'UTF8')), 'hex'), '-'),
    COALESCE(encode(sha256(convert_to(a."ipAddress", 'UTF8')), 'hex'), '-'),
    COALESCE(encode(sha256(convert_to(a."oldValue"::text, 'UTF8')), 'hex'), '-'),
    COALESCE(encode(sha256(convert_to(a."newValue"::text, 'UTF8')), 'hex'), '-'),
    btrim(p_reason), btrim(p_operator));

  PERFORM set_config('cf.audit_redaction', 'on', true);
  UPDATE "AuditLog" SET
    "userEmail" = CASE WHEN 'userEmail' = ANY(p_columns) THEN NULL ELSE "userEmail" END,
    "ipAddress" = CASE WHEN 'ipAddress' = ANY(p_columns) THEN NULL ELSE "ipAddress" END,
    "oldValue" = CASE WHEN 'oldValue' = ANY(p_columns) THEN NULL ELSE "oldValue" END,
    "newValue" = CASE WHEN 'newValue' = ANY(p_columns) THEN NULL ELSE "newValue" END
  WHERE "id" = a."id";
  PERFORM set_config('cf.audit_redaction', 'off', true);

  INSERT INTO "AuditLog" ("id", "tenantId", "action", "entity", "entityId", "newValue")
  VALUES (
    'aud_' || replace(gen_random_uuid()::text, '-', ''), a."tenantId", 'AUDIT_ROW_REDACTED', 'AuditLog', a."id",
    jsonb_build_object('columns', to_jsonb(p_columns), 'reason', btrim(p_reason), 'operator', btrim(p_operator),
                       'databaseRole', session_user::text, 'rowAction', a."action"));
END;
$$;
REVOKE ALL ON FUNCTION public.audit_log_redact(text, text[], text, text) FROM PUBLIC;

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

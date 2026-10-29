-- Tamper-evident audit (LPB tender spec 2.8.5, 4.7).
--
-- 1. AuditLog is append-only: UPDATE, DELETE and TRUNCATE are refused by
--    triggers, and the user/tenant foreign keys no longer SET NULL (that is an
--    UPDATE). Nothing in the application updates or deletes an audit row.
-- 2. Every row carries chainSeq, prevHash and rowHash, computed by the
--    AuditLog_zz_chain trigger (after the content guards, which may rewrite the
--    row). One chain per tenant, rows with no tenant are one more; concurrent
--    inserts serialise on the chain's AuditChainHead row lock, held to commit.
-- 3. A lender's SIEM forwarding fills AuditSiemOutbox from a trigger, in the
--    audit row's own transaction.
--
-- Adds enforcement: ships with the code (lib/audit/). Existing rows are chained
-- here, ordered by (createdAt, id).

-- CreateEnum
CREATE TYPE "AuditSiemTransport" AS ENUM ('SYSLOG_TLS', 'HTTPS_JSON');

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_userId_fkey";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "chainSeq" INTEGER,
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "rowHash" TEXT;

-- CreateTable
CREATE TABLE "AuditChainHead" (
    "chainKey" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,
    "lastHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditChainHead_pkey" PRIMARY KEY ("chainKey")
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
    "auditLogId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "chainSeq" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditSiemOutbox_pkey" PRIMARY KEY ("auditLogId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditPolicy_tenantId_key" ON "AuditPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "AuditSiemOutbox_tenantId_sentAt_nextAttemptAt_idx" ON "AuditSiemOutbox"("tenantId", "sentAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "AuditPolicy" ADD CONSTRAINT "AuditPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


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

-- ── Hand-written: the hash ──────────────────────────────────────────────────
-- The one definition of a row's hash: the trigger writes it and the verifier
-- recomputes it with this function. The text is a JSON array (jsonb prints keys
-- and numbers canonically), so a column's SQL NULL and the JSON null in a jsonb
-- column hash differently. 'v1' versions the layout.

CREATE FUNCTION public.audit_log_row_hash(a "AuditLog") RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    'v1', a."id", a."tenantId", a."userId", a."userEmail", a."action", a."entity", a."entityId",
    a."oldValue"::text, a."newValue"::text, a."ipAddress",
    to_char(a."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), a."chainSeq", a."prevHash"
  )::text, 'UTF8')), 'hex')
$$;

-- ── Chain the existing rows (the user triggers are off for this only) ───────

ALTER TABLE "AuditLog" DISABLE TRIGGER USER;

DO $$
DECLARE
  r RECORD;
  chain_key TEXT := NULL;
  seq INTEGER := 0;
  prev TEXT := repeat('0', 64);
  cur "AuditLog";
BEGIN
  FOR r IN SELECT "id", COALESCE("tenantId", '') AS k FROM "AuditLog" ORDER BY COALESCE("tenantId", ''), "createdAt", "id" LOOP
    IF chain_key IS DISTINCT FROM r.k THEN
      IF chain_key IS NOT NULL THEN
        INSERT INTO "AuditChainHead" ("chainKey", "lastSeq", "lastHash") VALUES (chain_key, seq, prev);
      END IF;
      chain_key := r.k; seq := 0; prev := repeat('0', 64);
    END IF;
    seq := seq + 1;
    UPDATE "AuditLog" SET "chainSeq" = seq, "prevHash" = prev WHERE "id" = r."id" RETURNING * INTO cur;
    prev := public.audit_log_row_hash(cur);
    UPDATE "AuditLog" SET "rowHash" = prev WHERE "id" = r."id";
  END LOOP;
  IF chain_key IS NOT NULL THEN
    INSERT INTO "AuditChainHead" ("chainKey", "lastSeq", "lastHash") VALUES (chain_key, seq, prev);
  END IF;
END $$;

ALTER TABLE "AuditLog" ENABLE TRIGGER USER;

-- No CHECK that the chain columns are set: a row written with triggers off (a
-- data-only restore, a superuser in replica mode) has none, and the verifier
-- reports it as an unchained_row instead of the write failing.
CREATE UNIQUE INDEX "AuditLog_chain_seq_key" ON "AuditLog" (COALESCE("tenantId", ''), "chainSeq");

-- ── Hand-written: append-only ───────────────────────────────────────────────

CREATE FUNCTION public.audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'AuditLog is append-only: rows are never updated, deleted or truncated';
END;
$$;
-- "_a_" sorts before every other AuditLog trigger, so a refusal is the first word.
CREATE TRIGGER "AuditLog_a_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.audit_log_append_only();
CREATE TRIGGER "AuditLog_a_append_only_truncate" BEFORE TRUNCATE ON "AuditLog"
FOR EACH STATEMENT EXECUTE FUNCTION public.audit_log_append_only();

-- ── Hand-written: the chain ─────────────────────────────────────────────────
-- Runs after the content guards (AuditLog_legacy_placeholder_guard,
-- AuditLog_truthful_dry_run rewrite NEW; triggers fire in name order), so the
-- hash covers the row as stored. The head row lock is held until commit: the
-- next insert on the chain sees this one's seq and hash.

CREATE FUNCTION public.audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k TEXT := COALESCE(NEW."tenantId", '');
  head RECORD;
BEGIN
  INSERT INTO "AuditChainHead" ("chainKey", "lastSeq", "lastHash") VALUES (k, 0, repeat('0', 64))
  ON CONFLICT ("chainKey") DO NOTHING;
  SELECT "lastSeq", "lastHash" INTO head FROM "AuditChainHead" WHERE "chainKey" = k FOR UPDATE;
  NEW."chainSeq" := head."lastSeq" + 1;
  NEW."prevHash" := head."lastHash";
  NEW."rowHash" := public.audit_log_row_hash(NEW);
  UPDATE "AuditChainHead" SET "lastSeq" = NEW."chainSeq", "lastHash" = NEW."rowHash", "updatedAt" = now() WHERE "chainKey" = k;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AuditLog_zz_chain" BEFORE INSERT ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.audit_log_chain();

-- ── Hand-written: SIEM outbox ───────────────────────────────────────────────
-- A tenant's row is queued only while its policy forwards. Platform rows (no
-- tenant) have no policy and are not forwarded.

CREATE FUNCTION public.audit_log_siem_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."tenantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "AuditPolicy" p WHERE p."tenantId" = NEW."tenantId" AND p."siemEnabled"
  ) THEN
    INSERT INTO "AuditSiemOutbox" ("auditLogId", "tenantId", "chainSeq") VALUES (NEW."id", NEW."tenantId", NEW."chainSeq");
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "AuditLog_siem_enqueue" AFTER INSERT ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION public.audit_log_siem_enqueue();

-- Asset-finance slice 4b: the IsaFlow draft-journal push (lib/accounting/isaflow).
-- Additive: two new tables, their CHECKs and guard triggers. Nothing existing changes.

-- CreateEnum
CREATE TYPE "IsaFlowConnectionStatus" AS ENUM ('CONNECTED', 'NEEDS_RECONNECT', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "IsaFlowTokenKind" AS ENUM ('PAT', 'OAUTH');

-- CreateTable
CREATE TABLE "IsaFlowConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "IsaFlowConnectionStatus" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "tokenSealed" TEXT,
    "tokenKind" "IsaFlowTokenKind" NOT NULL DEFAULT 'PAT',
    "isaflowCompanyId" TEXT,
    "isaflowCompanyName" TEXT,
    "connectedById" TEXT NOT NULL,
    "connectedWithTotp" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMP(3) NOT NULL,
    "lastVerifiedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IsaFlowConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingIsaFlowPush" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "status" "AccountingPushStatus" NOT NULL,
    "externalRef" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestJson" TEXT NOT NULL,
    "requestSha256" TEXT NOT NULL,
    "isaflowCompanyId" TEXT NOT NULL,
    "isaflowJournalId" TEXT,
    "foundOnReadBack" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "pushedById" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingIsaFlowPush_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IsaFlowConnection_tenantId_key" ON "IsaFlowConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingIsaFlowPush_batchId_key" ON "AccountingIsaFlowPush"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingIsaFlowPush_idempotencyKey_key" ON "AccountingIsaFlowPush"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingIsaFlowPush_tenantId_batchId_key" ON "AccountingIsaFlowPush"("tenantId", "batchId");

-- AddForeignKey
ALTER TABLE "IsaFlowConnection" ADD CONSTRAINT "IsaFlowConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingIsaFlowPush" ADD CONSTRAINT "AccountingIsaFlowPush_tenantId_batchId_fkey" FOREIGN KEY ("tenantId", "batchId") REFERENCES "AccountingExportBatch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ── Hand-written: IsaFlow connection ────────────────────────────────────────

-- A token is stored only sealed (lib/integrations/tenant-credentials.ts sealCredential),
-- and only while CONNECTED: disconnecting or a refused token clears it.
ALTER TABLE "IsaFlowConnection" ADD CONSTRAINT "IsaFlowConnection_token_sealed_iff_connected"
  CHECK ((("status" = 'CONNECTED') = ("tokenSealed" IS NOT NULL)) AND ("tokenSealed" IS NULL OR "tokenSealed" LIKE 'enc:v1:%'));
ALTER TABLE "IsaFlowConnection" ADD CONSTRAINT "IsaFlowConnection_connected_has_company"
  CHECK ("status" <> 'CONNECTED' OR "isaflowCompanyId" IS NOT NULL);

-- A connection becomes CONNECTED (or changes its token, address or company
-- while connected) only for a SUPER_ADMIN of the same tenant whose session
-- verified a TOTP code. A connection row is never deleted.
CREATE OR REPLACE FUNCTION public."guardIsaFlowConnection"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'IsaFlow connection guard: a connection is never deleted; disconnect it';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'IsaFlow connection guard: a connection stays with its tenant';
  END IF;
  IF NEW."status" = 'CONNECTED' AND (
    TG_OP = 'INSERT'
    OR OLD."status" IS DISTINCT FROM 'CONNECTED'
    OR NEW."tokenSealed" IS DISTINCT FROM OLD."tokenSealed"
    OR NEW."baseUrl" IS DISTINCT FROM OLD."baseUrl"
    OR NEW."isaflowCompanyId" IS DISTINCT FROM OLD."isaflowCompanyId"
    OR NEW."connectedById" IS DISTINCT FROM OLD."connectedById"
    OR NEW."connectedWithTotp" IS DISTINCT FROM OLD."connectedWithTotp"
  ) THEN
    IF NEW."connectedWithTotp" IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'IsaFlow connection guard: connecting needs a TOTP-verified session';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "User" u
      WHERE u."id" = NEW."connectedById" AND u."tenantId" = NEW."tenantId"
        AND u."role" = 'SUPER_ADMIN' AND u."active") THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'IsaFlow connection guard: only an active SUPER_ADMIN of the tenant connects IsaFlow';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardIsaFlowConnection"
  BEFORE INSERT OR UPDATE OR DELETE ON "IsaFlowConnection"
  FOR EACH ROW EXECUTE FUNCTION public."guardIsaFlowConnection"();

-- ── Hand-written: IsaFlow push ──────────────────────────────────────────────

-- The key and reference are the batch's own; the stored request is the one
-- its hash names; PUSHED names the IsaFlow draft.
ALTER TABLE "AccountingIsaFlowPush" ADD CONSTRAINT "AccountingIsaFlowPush_idempotency_key_bound"
  CHECK ("idempotencyKey" = 'credaflow:batch:' || "batchId");
ALTER TABLE "AccountingIsaFlowPush" ADD CONSTRAINT "AccountingIsaFlowPush_external_ref_bound"
  CHECK ("externalRef" = "batchId");
ALTER TABLE "AccountingIsaFlowPush" ADD CONSTRAINT "AccountingIsaFlowPush_request_sha256"
  CHECK ("requestSha256" = encode(sha256(convert_to("requestJson", 'UTF8')), 'hex'));
ALTER TABLE "AccountingIsaFlowPush" ADD CONSTRAINT "AccountingIsaFlowPush_pushed_has_journal"
  CHECK ("status" <> 'PUSHED' OR "isaflowJournalId" IS NOT NULL);

-- The Xero push guard (20261015090000) for IsaFlow: claimed SENDING for a
-- CLOSED batch before the request leaves; PUSHED is final. One difference:
-- NEEDS_REVIEW may be claimed SENDING again, because every send carries the
-- same stored request under the same idempotency key and IsaFlow replays it
-- rather than creating a second draft. That holds only while the request, its
-- hash, the key and the company never change, so they are immutable here, and
-- the IsaFlow journal id, once recorded, is never replaced. A claim starts
-- empty and is made by a user of the tenant; leaving review other than by a
-- resend names the user of the tenant who resolved it.
CREATE OR REPLACE FUNCTION public."guardAccountingIsaFlowPush"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: a push record is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SENDING' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting push guard: a push starts as a SENDING claim';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "AccountingExportBatch" b
      WHERE b."id" = NEW."batchId" AND b."tenantId" = NEW."tenantId" AND b."status" = 'CLOSED') THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting push guard: only a closed batch is pushed';
    END IF;
    IF NEW."isaflowJournalId" IS NOT NULL OR NEW."resolvedById" IS NOT NULL OR NEW."resolutionNote" IS NOT NULL
      OR NEW."foundOnReadBack" IS NOT FALSE THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'Accounting push guard: a claim starts with no journal, resolution or read-back';
    END IF;
  ELSIF NEW."batchId" IS DISTINCT FROM OLD."batchId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: a push stays with its batch';
  END IF;
  -- Whoever claims a push, or resolves one, is a user of the batch's tenant.
  IF (TG_OP = 'INSERT' OR NEW."pushedById" IS DISTINCT FROM OLD."pushedById")
    AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."pushedById" AND u."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: a push is claimed by a user of its tenant';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  -- Out of review, other than by resending, only by a person's resolution.
  IF OLD."status" = 'NEEDS_REVIEW' AND NEW."status" IN ('PUSHED', 'FAILED')
    AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."resolvedById" AND u."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: a push in review is resolved by a user of its tenant';
  END IF;
  IF NEW."requestJson" IS DISTINCT FROM OLD."requestJson"
    OR NEW."requestSha256" IS DISTINCT FROM OLD."requestSha256"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."externalRef" IS DISTINCT FROM OLD."externalRef"
    OR NEW."isaflowCompanyId" IS DISTINCT FROM OLD."isaflowCompanyId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: the request, its key and its IsaFlow company never change';
  END IF;
  IF OLD."isaflowJournalId" IS NOT NULL AND NEW."isaflowJournalId" IS DISTINCT FROM OLD."isaflowJournalId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Accounting push guard: the IsaFlow journal id is written once';
  END IF;
  IF NOT (
    (OLD."status" = 'SENDING' AND NEW."status" IN ('PUSHED', 'FAILED', 'NEEDS_REVIEW'))
    OR (OLD."status" = 'FAILED' AND NEW."status" = 'SENDING')
    OR (OLD."status" = 'NEEDS_REVIEW' AND NEW."status" IN ('SENDING', 'PUSHED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('Accounting push guard: %s -> %s is not allowed', OLD."status", NEW."status");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardAccountingIsaFlowPush"
  BEFORE INSERT OR UPDATE OR DELETE ON "AccountingIsaFlowPush"
  FOR EACH ROW EXECUTE FUNCTION public."guardAccountingIsaFlowPush"();

-- A row trigger never sees TRUNCATE (20261015500000).
CREATE TRIGGER "AccountingIsaFlowPush_no_truncate"
  BEFORE TRUNCATE ON "AccountingIsaFlowPush"
  FOR EACH STATEMENT EXECUTE FUNCTION public."refuseAccountingTruncate"();

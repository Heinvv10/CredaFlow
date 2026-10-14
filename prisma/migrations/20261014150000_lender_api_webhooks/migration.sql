-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "apiKeyId" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "ipAddress" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "secretSealed" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "disabledById" TEXT,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastResponseStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronHeartbeat" (
    "job" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3) NOT NULL,
    "lastFinishedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,

    CONSTRAINT "CronHeartbeat_pkey" PRIMARY KEY ("job")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_createdAt_idx" ON "ApiKey"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_tenantId_id_key" ON "ApiKey"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ApiRequestLog_tenantId_createdAt_idx" ON "ApiRequestLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ApiRequestLog_apiKeyId_createdAt_idx" ON "ApiRequestLog"("apiKeyId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_active_idx" ON "WebhookEndpoint"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_tenantId_id_key" ON "WebhookEndpoint"("tenantId", "id");

-- CreateIndex
CREATE INDEX "WebhookEvent_dispatchedAt_createdAt_idx" ON "WebhookEvent"("dispatchedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_tenantId_id_key" ON "WebhookEvent"("tenantId", "id");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_tenantId_createdAt_idx" ON "WebhookDelivery"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_endpointId_eventId_key" ON "WebhookDelivery"("endpointId", "eventId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_revokedById_fkey" FOREIGN KEY ("tenantId", "revokedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_disabledById_fkey" FOREIGN KEY ("tenantId", "disabledById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_endpointId_fkey" FOREIGN KEY ("tenantId", "endpointId") REFERENCES "WebhookEndpoint"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_eventId_fkey" FOREIGN KEY ("tenantId", "eventId") REFERENCES "WebhookEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── Hand-written: checks and the webhook outbox triggers ─────────────────────
-- Additive: new tables only, plus AFTER triggers on LoanApplication, Loan and
-- Payment that write an outbox row only while the tenant has an active
-- WebhookEndpoint subscribed to the event type. They reject no write.

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_scopes_check" CHECK (
  cardinality("scopes") > 0
  AND "scopes" <@ ARRAY['clients:read', 'applications:read', 'applications:write', 'loans:read', 'payments:read', 'pii:read']::text[]
);
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_revocation_check" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL));
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_expiry_check" CHECK ("expiresAt" > "createdAt");

ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_events_check" CHECK (
  cardinality("events") > 0
  AND "events" <@ ARRAY['application.created', 'application.status_changed', 'loan.disbursed', 'payment.received']::text[]
);
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_url_check" CHECK ("url" LIKE 'https://%');
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_disabled_check" CHECK (
  "active" = ("disabledAt" IS NULL) AND ("disabledAt" IS NULL) = ("disabledById" IS NULL)
);

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_attempts_check" CHECK ("attempts" >= 0);

CREATE OR REPLACE FUNCTION public.webhook_enqueue(p_tenant text, p_type text, p_entity text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "WebhookEndpoint" e
    WHERE e."tenantId" = p_tenant AND e."active" AND p_type = ANY (e."events")
  ) THEN
    INSERT INTO "WebhookEvent" ("tenantId", "type", "entityId", "data")
    VALUES (p_tenant, p_type, p_entity, p_data);
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION public.webhook_iso(p_at timestamp without time zone)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT to_char(p_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$function$;

CREATE OR REPLACE FUNCTION public.webhook_loan_application_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.webhook_enqueue(NEW."tenantId", 'application.created', NEW."id", jsonb_build_object(
      'id', NEW."id", 'reference', NEW."reference", 'status', NEW."status",
      'clientId', NEW."clientId", 'entityId', NEW."entityId", 'productId', NEW."productId",
      'appliedAmount', NEW."appliedAmount", 'appliedTermDays', NEW."appliedTermDays"));
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    PERFORM public.webhook_enqueue(NEW."tenantId", 'application.status_changed', NEW."id", jsonb_build_object(
      'id', NEW."id", 'reference', NEW."reference",
      'previousStatus', OLD."status", 'status', NEW."status"));
  END IF;
  RETURN NULL;
END
$function$;

CREATE TRIGGER webhook_loan_application_event AFTER INSERT OR UPDATE OF "status" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public.webhook_loan_application_event();

CREATE OR REPLACE FUNCTION public.webhook_loan_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.webhook_enqueue(NEW."tenantId", 'loan.disbursed', NEW."id", jsonb_build_object(
    'id', NEW."id", 'reference', NEW."reference", 'applicationId', NEW."applicationId",
    'clientId', NEW."clientId", 'entityId', NEW."entityId", 'principal', NEW."principal",
    'contractType', NEW."contractType", 'startDate', public.webhook_iso(NEW."startDate")));
  RETURN NULL;
END
$function$;

CREATE TRIGGER webhook_loan_event AFTER INSERT ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public.webhook_loan_event();

-- A refund-due split (parentPaymentId set) is part of an earlier receipt, not a new one.
CREATE OR REPLACE FUNCTION public.webhook_payment_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM public.webhook_enqueue(NEW."tenantId", 'payment.received', NEW."id", jsonb_build_object(
    'id', NEW."id", 'loanId', NEW."loanId", 'amount', NEW."amount",
    'paymentMethod', NEW."paymentMethod", 'allocationStatus', NEW."allocationStatus",
    'receivedAt', public.webhook_iso(NEW."receivedAt")));
  RETURN NULL;
END
$function$;

CREATE TRIGGER webhook_payment_event AFTER INSERT ON "Payment"
  FOR EACH ROW WHEN (NEW."parentPaymentId" IS NULL) EXECUTE FUNCTION public.webhook_payment_event();

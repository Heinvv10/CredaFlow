-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedReason" TEXT;

-- CreateTable
CREATE TABLE "WebhookOutboxFailure" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookOutboxFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookOutboxFailure_createdAt_idx" ON "WebhookOutboxFailure"("createdAt");


-- ── Hand-written ─────────────────────────────────────────────────────────────
-- Additive. The circuit-breaker columns above (lib/lender-api/webhooks/
-- circuit-breaker.ts) and a log of outbox events that could not be written.
-- The outbox trigger functions of 20261014150000_lender_api_webhooks are
-- replaced so they can never fail the write that fires them: each checks
-- first, cheaply and outside any subtransaction, whether the tenant has an
-- active endpoint for the type (almost always: no); only then does it build
-- the payload and insert, inside BEGIN … EXCEPTION. A fault there becomes a
-- WARNING, a WebhookOutboxFailure row (itself guarded) and a missing event,
-- never a refused payment, loan or application. The triggers are unchanged:
-- they call these functions by name.

ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_failures_check" CHECK ("consecutiveFailures" >= 0);

CREATE OR REPLACE FUNCTION public.webhook_subscribed(p_tenant text, p_type text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM "WebhookEndpoint" e
    WHERE e."tenantId" = p_tenant AND e."active" AND p_type = ANY (e."events")
  )
$function$;

CREATE OR REPLACE FUNCTION public.webhook_enqueue(p_tenant text, p_type text, p_entity text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO "WebhookEvent" ("tenantId", "type", "entityId", "data")
  VALUES (p_tenant, p_type, p_entity, p_data);
END
$function$;

CREATE OR REPLACE FUNCTION public.webhook_loan_application_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_type text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_type := 'application.created';
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    v_type := 'application.status_changed';
  ELSE
    RETURN NULL;
  END IF;
  IF NOT public.webhook_subscribed(NEW."tenantId", v_type) THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF v_type = 'application.created' THEN
      PERFORM public.webhook_enqueue(NEW."tenantId", v_type, NEW."id", jsonb_build_object(
        'id', NEW."id", 'reference', NEW."reference", 'status', NEW."status",
        'clientId', NEW."clientId", 'entityId', NEW."entityId", 'productId', NEW."productId",
        'appliedAmount', NEW."appliedAmount", 'appliedTermDays', NEW."appliedTermDays"));
    ELSE
      PERFORM public.webhook_enqueue(NEW."tenantId", v_type, NEW."id", jsonb_build_object(
        'id', NEW."id", 'reference', NEW."reference",
        'previousStatus', OLD."status", 'status', NEW."status"));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook outbox: % for LoanApplication % not enqueued: %', v_type, NEW."id", SQLERRM;
    BEGIN
      INSERT INTO "WebhookOutboxFailure" ("tenantId", "type", "entityId", "error")
      VALUES (NEW."tenantId", v_type, NEW."id", left(SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'webhook outbox: failure not recorded: %', SQLERRM;
    END;
  END;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.webhook_loan_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT public.webhook_subscribed(NEW."tenantId", 'loan.disbursed') THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.webhook_enqueue(NEW."tenantId", 'loan.disbursed', NEW."id", jsonb_build_object(
      'id', NEW."id", 'reference', NEW."reference", 'applicationId', NEW."applicationId",
      'clientId', NEW."clientId", 'entityId', NEW."entityId", 'principal', NEW."principal",
      'contractType', NEW."contractType", 'startDate', public.webhook_iso(NEW."startDate")));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook outbox: loan.disbursed for Loan % not enqueued: %', NEW."id", SQLERRM;
    BEGIN
      INSERT INTO "WebhookOutboxFailure" ("tenantId", "type", "entityId", "error")
      VALUES (NEW."tenantId", 'loan.disbursed', NEW."id", left(SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'webhook outbox: failure not recorded: %', SQLERRM;
    END;
  END;
  RETURN NULL;
END
$function$;

-- A refund-due split (parentPaymentId set) is part of an earlier receipt, not a new one.
CREATE OR REPLACE FUNCTION public.webhook_payment_event()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT public.webhook_subscribed(NEW."tenantId", 'payment.received') THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.webhook_enqueue(NEW."tenantId", 'payment.received', NEW."id", jsonb_build_object(
      'id', NEW."id", 'loanId', NEW."loanId", 'amount', NEW."amount",
      'paymentMethod', NEW."paymentMethod", 'allocationStatus', NEW."allocationStatus",
      'receivedAt', public.webhook_iso(NEW."receivedAt")));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'webhook outbox: payment.received for Payment % not enqueued: %', NEW."id", SQLERRM;
    BEGIN
      INSERT INTO "WebhookOutboxFailure" ("tenantId", "type", "entityId", "error")
      VALUES (NEW."tenantId", 'payment.received', NEW."id", left(SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'webhook outbox: failure not recorded: %', SQLERRM;
    END;
  END;
  RETURN NULL;
END
$function$;

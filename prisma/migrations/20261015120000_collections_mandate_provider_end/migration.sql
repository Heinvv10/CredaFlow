-- Collections engine: a provider may report an ACTIVE mandate EXPIRED or REJECTED
-- (the debtor's bank ended it). Widens guardDebitMandateStatus to allow
-- ACTIVE -> EXPIRED and ACTIVE -> REJECTED; every other rule is unchanged.
-- Loosens enforcement only: safe to apply ahead of the code.

CREATE OR REPLACE FUNCTION "guardDebitMandateStatus"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' THEN
      RAISE EXCEPTION 'DebitMandate % must be created in status CREATED, not %', NEW.id, NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."tenantId", NEW."loanId", NEW."clientId", NEW.provider, NEW."authType", NEW."amountCents",
      NEW."maxAmountCents", NEW."debitDay", NEW.frequency, NEW.adjustment, NEW."trackingDays",
      NEW."firstCollectionDate", NEW."accountHolder", NEW."bankName", NEW."branchCode",
      NEW."accountNumber", NEW."accountType", NEW."createdById")
     IS DISTINCT FROM
     (OLD."tenantId", OLD."loanId", OLD."clientId", OLD.provider, OLD."authType", OLD."amountCents",
      OLD."maxAmountCents", OLD."debitDay", OLD.frequency, OLD.adjustment, OLD."trackingDays",
      OLD."firstCollectionDate", OLD."accountHolder", OLD."bankName", OLD."branchCode",
      OLD."accountNumber", OLD."accountType", OLD."createdById") THEN
    RAISE EXCEPTION 'DebitMandate % terms are fixed once created: create a fresh mandate', NEW.id;
  END IF;
  IF OLD."providerMandateRef" IS NOT NULL AND NEW."providerMandateRef" IS DISTINCT FROM OLD."providerMandateRef" THEN
    RAISE EXCEPTION 'DebitMandate % provider reference is fixed once assigned', NEW.id;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'CREATED' AND NEW.status IN ('SUBMITTING', 'CANCELLED'))
    OR (OLD.status = 'SUBMITTING' AND NEW.status IN ('CREATED', 'PENDING_REGISTRATION', 'PENDING_AUTH', 'ACTIVE', 'REJECTED', 'CANCELLED'))
    OR (OLD.status = 'PENDING_REGISTRATION' AND NEW.status IN ('PENDING_AUTH', 'ACTIVE', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'PENDING_AUTH' AND NEW.status IN ('ACTIVE', 'REJECTED', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'CANCELLED', 'EXPIRED', 'REJECTED'))
    OR (OLD.status = 'SUSPENDED' AND NEW.status = 'CANCELLED')
  ) THEN
    RAISE EXCEPTION 'DebitMandate % cannot move from % to %', NEW.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;

-- W6 review round 2 (PR #89): a loan becomes CANCELLED only through an
-- approved disbursement reversal (lib/payouts/reversal.ts). Every figure that
-- treats a CANCELLED loan as owing nothing (lib/loan/charges-summary.ts
-- owesNothing, the NCA documents, the NCR return) relies on this. Exercised by
-- lib/payouts/reversal-pasq.integration.test.ts.
CREATE OR REPLACE FUNCTION public."guardLoanCancellation"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'CANCELLED'
    AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM 'CANCELLED')
    AND NOT EXISTS (
      SELECT 1 FROM "DisbursementReversal" r
      WHERE r."loanId" = NEW."id" AND r."tenantId" = NEW."tenantId" AND r."status" = 'APPROVED'
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Loan cancellation guard: a loan is CANCELLED only by an approved disbursement reversal';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "guardLoanCancellation"
  BEFORE INSERT OR UPDATE OF "status" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanCancellation"();

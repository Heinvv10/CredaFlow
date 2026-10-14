-- The original lock function remains unchanged for consumers. Entity NCA
-- quotations are EntityDocument rows and are locked by
-- guardAssetEntityNcaApplication instead.
DROP TRIGGER "LoanApplication_a_lock_pasq_document_on_update" ON "LoanApplication";
CREATE TRIGGER "LoanApplication_a_lock_pasq_document_on_update" BEFORE UPDATE ON "LoanApplication"
FOR EACH ROW WHEN ((((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text)))
  AND (NEW."entityId" IS NULL OR NEW."ncaRegime" IS DISTINCT FROM 'NCA'))
EXECUTE FUNCTION "lockLoanApplicationPasqDocument"();

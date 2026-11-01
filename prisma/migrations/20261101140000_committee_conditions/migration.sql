-- F9: the credit committee's conditions hold the agreement and the payout. Each condition of the application's latest approved case needs
-- a clearance row before the borrower signs (ZA or KEY_FACTS, agreementSignedAt) and before the application becomes DISBURSED, whichever code writes it.

CREATE TABLE "ApprovalConditionClearance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "conditionIndex" INTEGER NOT NULL,
    "condition" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "clearedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalConditionClearance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApprovalConditionClearance_caseId_conditionIndex_key" ON "ApprovalConditionClearance"("caseId", "conditionIndex");
CREATE INDEX "ApprovalConditionClearance_tenantId_applicationId_idx" ON "ApprovalConditionClearance"("tenantId", "applicationId");
ALTER TABLE "ApprovalConditionClearance" ADD CONSTRAINT "ApprovalConditionClearance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ApprovalConditionClearance" ADD CONSTRAINT "ApprovalConditionClearance_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "ApprovalCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ApprovalConditionClearance" ADD CONSTRAINT "ApprovalConditionClearance_tenantId_clearedById_fkey" FOREIGN KEY ("tenantId", "clearedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "ApprovalConditionClearance_append_only" BEFORE UPDATE OR DELETE ON "ApprovalConditionClearance" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalAppendOnly"();
CREATE TRIGGER "ApprovalConditionClearance_no_truncate" BEFORE TRUNCATE ON "ApprovalConditionClearance" FOR EACH STATEMENT EXECUTE FUNCTION public."guardApprovalAppendOnly"();

-- The application's conditions: of its latest approved case, every level's, in level order. An earlier approval that was sent back has no say.
CREATE OR REPLACE FUNCTION public."committeeConditionsCase"(tenant_id TEXT, application_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $function$
  SELECT c."id" FROM "ApprovalCase" c
  WHERE c."tenantId" = tenant_id AND c."applicationId" = application_id AND c."status" = 'APPROVED'
  ORDER BY c."completedAt" DESC NULLS LAST, c."id" DESC LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public."committeeConditions"(case_id TEXT)
RETURNS TEXT[] LANGUAGE sql STABLE AS $function$
  SELECT COALESCE(array_agg(item.value ORDER BY s."level", item.ordinality), '{}')
  FROM "ApprovalStep" s
  CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(s."conditions") = 'array' THEN s."conditions" ELSE '[]'::jsonb END) WITH ORDINALITY AS item(value, ordinality)
  WHERE s."caseId" = case_id;
$function$;

CREATE OR REPLACE FUNCTION public."committeeConditionsOutstanding"(tenant_id TEXT, application_id TEXT)
RETURNS INTEGER LANGUAGE plpgsql STABLE AS $function$
DECLARE
  case_id TEXT := public."committeeConditionsCase"(tenant_id, application_id);
BEGIN
  IF case_id IS NULL THEN RETURN 0; END IF;
  RETURN COALESCE(array_length(public."committeeConditions"(case_id), 1), 0)
    - (SELECT count(*)::int FROM "ApprovalConditionClearance" k WHERE k."caseId" = case_id);
END;
$function$;

-- A clearance: of a condition of the application's current approval, in the committee's words, by active staff who did not make the application.
CREATE OR REPLACE FUNCTION public."guardApprovalConditionClearance"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  conditions TEXT[];
BEGIN
  IF public."committeeConditionsCase"(NEW."tenantId", NEW."applicationId") IS DISTINCT FROM NEW."caseId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A condition is cleared on the application''s current approval';
  END IF;
  conditions := public."committeeConditions"(NEW."caseId");
  IF NEW."conditionIndex" < 0 OR conditions[NEW."conditionIndex" + 1] IS DISTINCT FROM NEW."condition" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A clearance names a condition of the approval, in the committee''s words';
  END IF;
  IF length(btrim(NEW."note")) < 5 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A clearance says what shows the condition is met';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = NEW."clearedById" AND u."tenantId" = NEW."tenantId" AND u."active" AND NOT u."isSystem") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A condition is cleared by an active staff member, never the automated decisioning account';
  END IF;
  IF EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId" AND NEW."clearedById" = ANY (COALESCE(a."inputStaffIds", '{}'))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Maker-checker: the staff member who captured the application or changed its inputs cannot clear its conditions';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "ApprovalConditionClearance_guard" BEFORE INSERT ON "ApprovalConditionClearance" FOR EACH ROW EXECUTE FUNCTION public."guardApprovalConditionClearance"();

-- The application: no signature and no payout over an open condition; and whoever said a condition is met does not also pay the loan out.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationCommitteeConditions"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF public."committeeConditionsOutstanding"(NEW."tenantId", NEW."id") > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The credit committee''s conditions must all be cleared before the agreement is signed or the loan is paid out';
  END IF;
  IF NEW."status" = 'DISBURSED'::"AppStatus" AND OLD."status" IS DISTINCT FROM 'DISBURSED'::"AppStatus"
    AND NEW."disbursedById" IS NOT NULL AND "tenantRequiresSegregationOfDuties"(NEW."tenantId")
    AND EXISTS (SELECT 1 FROM "ApprovalConditionClearance" k WHERE k."caseId" = public."committeeConditionsCase"(NEW."tenantId", NEW."id") AND k."clearedById" = NEW."disbursedById")
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Segregation of duties: a staff member who cleared a committee condition cannot disburse the application';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanApplication_0_guard_committee_conditions" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW
  WHEN ((new."agreementSignedAt" IS NOT NULL AND old."agreementSignedAt" IS NULL) OR (new.status = 'DISBURSED'::"AppStatus" AND old.status IS DISTINCT FROM 'DISBURSED'::"AppStatus"))
  EXECUTE FUNCTION public."guardLoanApplicationCommitteeConditions"();

ALTER TABLE "ApprovalConditionClearance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalConditionClearance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ApprovalConditionClearance" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

-- Adapt only the identity key used by the existing PASQ-v3 ledger validator:
-- a natural borrower is keyed by Loan.clientId; an entity NCA borrower is
-- keyed by its frozen authorised representative on the application.
DO $body$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_functiondef(('public."validateLoanPasq' || 'V3Billing"(text)')::regprocedure) INTO definition;
  changed := replace(definition,
    'application."pasqVersion",' || chr(10) || '    application."pasqEvidence"',
    'application."pasqVersion",' || chr(10) || '    application."ncaRepresentativeClientId",' || chr(10) || '    application."pasqEvidence"');
  changed := replace(changed,
    'booked."clientId" <> booked."pasqEvidence" ->> ''clientId''',
    'COALESCE(booked."clientId", booked."ncaRepresentativeClientId") <> booked."pasqEvidence" ->> ''clientId''');
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'validateLoanPasq' || 'V3Billing source shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

-- Entity NCA credit-life is offered and declined by the representative in
-- this slice. Preserve the consumer bundled-policy invariant; the entity
-- branch requires no bundled policy and verifies the matched entity loan.
DO $body$
DECLARE definition TEXT; changed TEXT; needle TEXT; replacement TEXT;
BEGIN
  SELECT pg_get_functiondef(('public."assertDisbursedCreditLife' || 'Coverage"(text)')::regprocedure) INTO definition;
  needle := '  elected_credit_life := "resolveCreditLife' || 'ElectionForLoan"(';
  replacement := '  IF application_entity_id IS NOT NULL AND application_nca_regime = ''NCA'' THEN' || chr(10)
    || '    IF loan_entity_id IS DISTINCT FROM application_entity_id OR loan_client_id IS NOT NULL' || chr(10)
    || '      OR NOT EXISTS (SELECT 1 FROM "LoanApplication" a WHERE a."id"=target_application_id AND a."creditLifeElection"=''DECLINED'')' || chr(10)
    || '      OR EXISTS (SELECT 1 FROM "InsurancePolicy" p WHERE p."linkedLoanId"=loan_id AND p."type"=''CREDIT_LIFE'' AND p."policySource"=''BUNDLED_CREDIT_AGREEMENT'') THEN' || chr(10)
    || '      RAISE EXCEPTION USING ERRCODE=''23514'', MESSAGE=''Entity NCA loan requires its matched entity, declined credit life and no bundled policy'';' || chr(10)
    || '    END IF;' || chr(10)
    || '    RETURN;' || chr(10)
    || '  END IF;' || chr(10) || chr(10)
    || needle;
  changed := replace(definition, needle, replacement);
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'assertDisbursedCreditLife' || 'Coverage source shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

CREATE OR REPLACE FUNCTION public."guardAssetEntityNcaDisbursedLoan"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."entityId" IS NOT NULL AND NEW."ncaRegime"='NCA' AND NEW."status"='DISBURSED' AND NOT EXISTS (
    SELECT 1 FROM "Loan" l JOIN "AssetFinanceDeal" d ON d."applicationId"=NEW."id" AND d."tenantId"=NEW."tenantId"
    WHERE l."applicationId"=NEW."id" AND l."tenantId"=NEW."tenantId" AND l."entityId"=NEW."entityId"
      AND l."clientId" IS NULL AND l."ncaRegime"='NCA' AND l."assetId"=d."assetId" AND l."contractType"=d."contractType"
  ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Entity NCA disbursement requires its matched entity asset loan'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanApplication_asset_entity_nca_disbursed_loan" BEFORE INSERT OR UPDATE OF status ON "LoanApplication"
FOR EACH ROW EXECUTE FUNCTION "guardAssetEntityNcaDisbursedLoan"();

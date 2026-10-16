-- Countersign after the debit mandate (Fair Score audit 2026-10-16, BLOCKER 1).
--
-- The portal lets the borrower sign the debit mandate once they have signed the
-- agreement, before the provider countersigns. guardSignedDebitMandateAuthority
-- (baseline) froze the agreementCountersigned* columns as soon as the mandate
-- was signed, so the provider's countersignature then raised 23514 and the
-- application could never be disbursed. Either order is now valid: the
-- countersignature may go NULL -> value once while the mandate is signed. A
-- second countersignature is still refused (here, and by
-- guardLoanApplicationProviderCountersign), and every other frozen field stays
-- frozen. The function is otherwise the baseline's, verbatim.

CREATE OR REPLACE FUNCTION public."guardSignedDebitMandateAuthority"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  expected_review_affordability JSONB;
  old_approval_history JSONB;
  old_contract_history JSONB;
  old_approval_history_present BOOLEAN;
  old_contract_history_present BOOLEAN;
  old_approval JSONB;
  new_approval JSONB;
  old_contract JSONB;
  new_contract JSONB;
  active_return_to_review BOOLEAN;
  approval_install_allowed BOOLEAN;
  contract_install_allowed BOOLEAN;
  countersign_once BOOLEAN;
BEGIN
  old_approval := OLD."affordabilityResult" -> 'approval';
  new_approval := NEW."affordabilityResult" -> 'approval';
  old_contract := OLD."affordabilityResult" -> 'contract';
  new_contract := NEW."affordabilityResult" -> 'contract';

  active_return_to_review := COALESCE((
    OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."approvedAt" IS NULL
    AND NEW."approvedById" IS NULL
    AND NEW."approvedAmount" IS NULL
    AND NEW."approvedTermDays" IS NULL
    AND NEW."approvedRate" IS NULL
    AND NEW."decisionReason" IS NULL
    AND NEW."pasqVersion" IS NULL
    AND NEW."pasqGeneratedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
    AND NEW."pasqEvidence" IS NULL
    AND NEW."pasqEvidenceSha256" IS NULL
    AND NEW."pasqAcknowledgedAt" IS NULL
    AND NEW."pasqAcknowledgedBy" IS NULL
    AND NEW."pasqAcknowledgedSha256" IS NULL
    AND NEW."approvedPasqDocumentSha256" IS NULL
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
  ), FALSE);

  IF new_approval IS DISTINCT FROM old_approval THEN
    approval_install_allowed := FALSE;
    IF JSONB_TYPEOF(new_approval) = 'object' THEN
      approval_install_allowed := COALESCE((
        OLD."status"::TEXT = 'UNDER_REVIEW'
        AND NEW."status"::TEXT = 'APPROVED'
        AND NEW."approvedAt" IS NOT NULL
        AND NEW."approvedById" IS NOT NULL
        AND NEW."approvedAmount" IS NOT NULL
        AND NEW."approvedTermDays" IS NOT NULL
        AND NEW."approvedRate" IS NOT NULL
        AND (
          -- NCA s.92(1) attaches the quotation to ENTERING INTO the agreement,
          -- not to the credit decision. Under ceremony sequencing no quotation
          -- exists at approval, so these bindings apply only once one does.
          COALESCE(JSONB_TYPEOF(NEW."pasqEvidence"), 'null') = 'null'
          OR (
            NEW."pasqVersion" = 'pasq-v3'
            AND JSONB_TYPEOF(NEW."pasqEvidence") = 'object'
            AND "pasqEvidenceSha256V3"(NEW."pasqEvidence")
              = NEW."pasqEvidenceSha256"
            AND NEW."approvedPasqDocumentSha256"
              = NEW."pasqDocumentSha256"
          )
        )
        AND NEW."affordabilityResult" ->> 'schemaVersion' = '3'
        AND new_approval ->> 'stage' = 'APPROVAL'
        AND new_approval ->> 'policyVersion' = 'approval-ndi-v3'
        AND "approvalEvidenceIsIntact"(new_approval)
        AND "approvalFinancialsAreConsistent"(new_approval)
        AND new_approval ->> 'capturedById' = NEW."approvedById"
        AND new_approval ->> 'capturedAt' = TO_CHAR(
          NEW."approvedAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
        AND new_approval #>> '{inputs,productId}' = NEW."productId"
        AND new_approval #>> '{inputs,principalCents}'
          = NEW."approvedAmount"::TEXT
        AND NEW."approvedAmount" = NEW."appliedAmount"
        AND new_approval #>> '{inputs,termDays}'
          = NEW."approvedTermDays"::TEXT
        AND NEW."approvedTermDays" = NEW."appliedTermDays"
        AND new_approval #>> '{inputs,interestRatePm}'
          = TO_JSONB(NEW."approvedRate")::TEXT
        AND new_approval #>> '{inputs,initiationFeePayment}'
          = NEW."initiationFeePayment"::TEXT
        AND new_approval #>> '{calculator,principalCents}'
          = NEW."approvedAmount"::TEXT
        AND (
          -- The approval snapshot used to be forced to share ONE calculator
          -- object with the PASQ, which is what made pasqGeneratedAt the
          -- approval anchor. Approval now anchors on approvedAt and the
          -- quotation is issued later, so the two can no longer be identical.
          -- Where a PASQ IS present at approval the original identity rule is
          -- kept verbatim; where it is not, the ceremony window's
          -- pricing-fingerprint clause reconciles them when the quotation is
          -- eventually issued.
          COALESCE(JSONB_TYPEOF(NEW."pasqEvidence"), 'null') = 'null'
          OR (
            new_approval #> '{calculator}'
              IS NOT DISTINCT FROM NEW."pasqEvidence" -> 'calculator'
            AND NEW."pasqEvidence" ->> 'termDays'
              = NEW."approvedTermDays"::TEXT
          )
        )
        AND new_approval #>> '{outcome,isAffordable}' = 'true'
        AND NEW."totalExistingDebt"::TEXT
          = new_approval #>> '{inputs,declaredDebtCents}'
        AND NEW."netDisposableIncome"::TEXT
          = new_approval #>> '{outcome,netDisposableIncomeCents}'
        AND NEW."affordabilityNDI"::TEXT
          = new_approval #>> '{outcome,ndiAfterLoanCents}'
        AND new_approval ->> 'inputFingerprint'
          ~ '^[0-9a-f]{64}$'
        AND new_approval ->> 'decisionFingerprint'
          ~ '^[0-9a-f]{64}$'
        AND new_approval #>> '{expenses,fingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND new_approval #>> '{debts,applicationFingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND new_approval #>> '{debts,clientFingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND (
          new_approval - ARRAY[
            'stage',
            'policyVersion',
            'capturedAt',
            'capturedById',
            'inputs',
            'debts',
            'expenses',
            'bureauEvidence',
            'calculator',
            'outcome',
            'inputFingerprint',
            'decisionFingerprint'
          ]
        ) = '{}'::JSONB
        AND EXISTS (
          SELECT 1
          FROM "LoanProduct" AS product
          WHERE product."id" = NEW."productId"
            AND product."tenantId" = NEW."tenantId"
            AND new_approval #>> '{inputs,interestRatePm}'
              = TO_JSONB(product."interestRatePm")::TEXT
            AND new_approval #>> '{inputs,interestModel}'
              = product."interestModel"::TEXT
            AND new_approval #>> '{inputs,initiationFeeModel}'
              = product."initiationFeeModel"::TEXT
            AND new_approval #>> '{inputs,initiationFeePct}'
              = TO_JSONB(product."initiationFeePct")::TEXT
            AND new_approval #>> '{inputs,initiationFeeMaxCents}'
              = product."initiationFeeMax"::TEXT
            AND new_approval #>> '{inputs,monthlyServiceFeeCents}'
              = product."monthlyServiceFee"::TEXT
            AND new_approval #>> '{inputs,productType}'
              = product."productType"::TEXT
        )
        AND EXISTS (
          SELECT 1
          FROM "Client" AS client
          WHERE client."id" = NEW."clientId"
            AND client."tenantId" = NEW."tenantId"
            AND client."monthlyIncome"::TEXT
              = new_approval #>> '{inputs,monthlyIncomeCents}'
            AND client."monthlyExpenses"::TEXT
              = new_approval #>> '{inputs,monthlyExpensesCents}'
        )
      ), FALSE);

      IF NOT approval_install_allowed THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Active approval evidence requires a validated approval transition';
      END IF;
    ELSIF JSONB_TYPEOF(old_approval) = 'object'
      AND NOT active_return_to_review
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Active approval evidence may only be cleared by return to review';
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'approval',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Active approval evidence must be an object';
    END IF;
  END IF;

  IF new_contract IS DISTINCT FROM old_contract THEN
    contract_install_allowed := FALSE;
    IF JSONB_TYPEOF(new_contract) = 'object' THEN
      IF COALESCE((
        OLD."status"::TEXT = 'APPROVED'
        AND NEW."status"::TEXT = 'APPROVED'
        AND OLD."agreementSignedAt" IS NULL
        AND NEW."agreementSignedAt" IS NULL
        AND NEW."agreementGeneratedAt" IS NOT NULL
        AND NEW."agreementDocumentId" IS NOT NULL
        AND LENGTH(BTRIM(NEW."agreementDocumentId")) > 0
        AND NEW."agreementDocumentSha256" ~ '^[0-9a-f]{64}$'
        AND (
          NEW."agreementGeneratedAt"
            IS DISTINCT FROM OLD."agreementGeneratedAt"
          OR NEW."agreementDocumentId"
            IS DISTINCT FROM OLD."agreementDocumentId"
          OR NEW."agreementDocumentSha256"
            IS DISTINCT FROM OLD."agreementDocumentSha256"
        )
        AND JSONB_TYPEOF(new_approval) = 'object'
        AND JSONB_TYPEOF(new_contract -> 'calculator') = 'object'
        AND JSONB_TYPEOF(
          new_contract #> '{calculator,schedule}'
        ) = 'array'
        AND JSONB_TYPEOF(
          NEW."pasqEvidence" #> '{calculator,schedule}'
        ) = 'array'
        AND new_contract ->> 'version' = 'affordability-contract-v2'
        AND new_contract ->> 'establishedAt' = TO_CHAR(
          NEW."agreementGeneratedAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
        AND new_contract #>> '{calculator,startDate}'
          = new_contract ->> 'establishedAt'
        AND new_contract ->> 'acceptedPasqDocumentSha256'
          = NEW."pasqDocumentSha256"
        AND new_contract ->> 'acceptedPasqContractFingerprint'
          = NEW."pasqEvidence" #>> '{calculator,contractFingerprint}'
        AND new_contract ->> 'quotePresentedAt'
          = NEW."pasqEvidence" #>> '{calculator,startDate}'
        AND new_contract ->> 'quoteValidUntilDate'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND new_contract ->> 'quoteValidUntilDate'
          = TO_CHAR(
            "quoteValidUntilDate"(
              (
                NEW."pasqEvidence" #>> '{calculator,startDate}'
              )::TIMESTAMPTZ
            ),
            'YYYY-MM-DD'
          )
        AND NEW."agreementGeneratedAt" >= (
          (
            NEW."pasqEvidence" #>> '{calculator,startDate}'
          )::TIMESTAMPTZ AT TIME ZONE 'UTC'
        )
        AND (
          NEW."agreementGeneratedAt" AT TIME ZONE 'UTC'
            AT TIME ZONE 'Africa/Johannesburg'
        )::DATE <= "quoteValidUntilDate"(
          (
            NEW."pasqEvidence" #>> '{calculator,startDate}'
          )::TIMESTAMPTZ
        )
        AND new_contract ->> 'approvalDecisionFingerprint'
          = new_approval ->> 'decisionFingerprint'
        -- The quotation must price what was actually approved. Under the old
        -- sequencing the approval snapshot and the PASQ shared one calculator
        -- OBJECT, so this was free; the two are now built at different instants
        -- and can no longer be identical, so they are reconciled on the
        -- date-independent pricing fingerprint instead. Enforced at agreement
        -- generation, the moment NCA s.92(1) actually turns on: the contract
        -- being entered into must carry the approved price and the quoted one.
        AND "calculatorPricingSha256"(
          NEW."pasqEvidence" -> 'calculator'
        ) = "calculatorPricingSha256"(new_approval -> 'calculator')
        AND new_contract ->> 'fingerprint' ~ '^[0-9a-f]{64}$'
        AND new_contract ->> 'fingerprint'
          = "contractEvidenceSha256"(new_contract)
        AND new_contract #>> '{calculator,contractFingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND new_contract #>> '{calculator,pricingFingerprint}'
          = "calculatorPricingSha256"(
            new_contract -> 'calculator'
          )
        AND new_contract #>> '{calculator,contractFingerprint}'
          = "calculatorContractSha256"(
            new_contract -> 'calculator'
          )
        AND (
          new_contract - ARRAY[
            'version',
            'establishedAt',
            'acceptedPasqDocumentSha256',
            'acceptedPasqContractFingerprint',
            'quotePresentedAt',
            'quoteValidUntilDate',
            'approvalDecisionFingerprint',
            'calculator',
            'fingerprint'
          ]
        ) = '{}'::JSONB
        AND (
          (new_contract -> 'calculator') - ARRAY[
            'startDate',
            'contractFingerprint',
            'schedule'
          ]
        ) IS NOT DISTINCT FROM (
          (NEW."pasqEvidence" -> 'calculator') - ARRAY[
            'startDate',
            'contractFingerprint',
            'schedule'
          ]
        )
        AND JSONB_ARRAY_LENGTH(
          new_contract #> '{calculator,schedule}'
        ) = JSONB_ARRAY_LENGTH(
          NEW."pasqEvidence" #> '{calculator,schedule}'
        )
      ), FALSE)
      THEN
        contract_install_allowed := NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            new_contract #> '{calculator,schedule}'
          ) WITH ORDINALITY AS contracted(value, ordinal)
          FULL JOIN JSONB_ARRAY_ELEMENTS(
            NEW."pasqEvidence" #> '{calculator,schedule}'
          ) WITH ORDINALITY AS quoted(value, ordinal)
            ON quoted.ordinal = contracted.ordinal
          WHERE contracted.value IS NULL
            OR quoted.value IS NULL
            OR contracted.value - 'dueDate'
              IS DISTINCT FROM quoted.value - 'dueDate'
            OR (
              (contracted.value ->> 'dueDate')::TIMESTAMPTZ
                AT TIME ZONE 'UTC'
            ) IS DISTINCT FROM (
              (
                (quoted.value ->> 'dueDate')::TIMESTAMPTZ
                  AT TIME ZONE 'UTC'
              )
              + (
                NEW."agreementGeneratedAt"
                - (
                  (
                    NEW."pasqEvidence"
                      #>> '{calculator,startDate}'
                  )::TIMESTAMPTZ AT TIME ZONE 'UTC'
                )
              )
            )
        );
      END IF;

      IF NOT contract_install_allowed THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Active contract evidence requires validated agreement generation';
      END IF;
    ELSIF JSONB_TYPEOF(old_contract) = 'object'
      AND NOT active_return_to_review
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Active contract evidence may only be cleared by return to review';
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'contract',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Active contract evidence must be an object';
    END IF;
  END IF;

  -- Decision histories are immutable except for the exact route-shaped
  -- archive event: when active evidence changes, append that exact OLD
  -- object once. This remains enforced after mandate fields are cleared.
  old_approval_history_present := COALESCE(
    JSONB_TYPEOF(OLD."affordabilityResult") = 'object'
      AND OLD."affordabilityResult" ? 'approvalHistory',
    FALSE
  );
  old_contract_history_present := COALESCE(
    JSONB_TYPEOF(OLD."affordabilityResult") = 'object'
      AND OLD."affordabilityResult" ? 'contractHistory',
    FALSE
  );

  IF old_approval_history_present
    AND JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'approvalHistory'
    ) IS DISTINCT FROM 'array'
  THEN
    IF NEW."affordabilityResult" -> 'approvalHistory'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'approvalHistory'
      OR NEW."affordabilityResult" -> 'approval'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'approval'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived approval evidence is immutable';
    END IF;
  ELSE
    old_approval_history := CASE
      WHEN old_approval_history_present
        THEN OLD."affordabilityResult" -> 'approvalHistory'
      ELSE '[]'::JSONB
    END;

    IF JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'approval'
    ) = 'object'
      AND NEW."affordabilityResult" -> 'approval'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'approval'
    THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'approvalHistory'
          AND NEW."affordabilityResult" -> 'approvalHistory'
            IS NOT DISTINCT FROM (
              old_approval_history
              || JSONB_BUILD_ARRAY(
                OLD."affordabilityResult" -> 'approval'
              )
            ),
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Archived approval evidence must exactly record the replaced decision';
      END IF;
    ELSIF old_approval_history_present THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'approvalHistory'
          AND NEW."affordabilityResult" -> 'approvalHistory'
            IS NOT DISTINCT FROM old_approval_history,
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Archived approval evidence is immutable';
      END IF;
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'approvalHistory',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived approval evidence cannot be fabricated';
    END IF;
  END IF;

  IF old_contract_history_present
    AND JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'contractHistory'
    ) IS DISTINCT FROM 'array'
  THEN
    IF NEW."affordabilityResult" -> 'contractHistory'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'contractHistory'
      OR NEW."affordabilityResult" -> 'contract'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'contract'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived contract evidence is immutable';
    END IF;
  ELSE
    old_contract_history := CASE
      WHEN old_contract_history_present
        THEN OLD."affordabilityResult" -> 'contractHistory'
      ELSE '[]'::JSONB
    END;

    IF JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'contract'
    ) = 'object'
      AND NEW."affordabilityResult" -> 'contract'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'contract'
    THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'contractHistory'
          AND NEW."affordabilityResult" -> 'contractHistory'
            IS NOT DISTINCT FROM (
              old_contract_history
              || JSONB_BUILD_ARRAY(
                OLD."affordabilityResult" -> 'contract'
              )
            ),
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Archived contract evidence must exactly record the replaced contract';
      END IF;
    ELSIF old_contract_history_present THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'contractHistory'
          AND NEW."affordabilityResult" -> 'contractHistory'
            IS NOT DISTINCT FROM old_contract_history,
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Archived contract evidence is immutable';
      END IF;
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'contractHistory',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived contract evidence cannot be fabricated';
    END IF;
  END IF;

  IF JSONB_TYPEOF(OLD."affordabilityResult") = 'object'
    AND JSONB_TYPEOF(OLD."affordabilityResult" -> 'approval') = 'object'
    AND JSONB_TYPEOF(OLD."affordabilityResult" -> 'contract') = 'object'
    AND (
      NOT (OLD."affordabilityResult" ? 'approvalHistory')
      OR JSONB_TYPEOF(
        OLD."affordabilityResult" -> 'approvalHistory'
      ) = 'array'
    )
    AND (
      NOT (OLD."affordabilityResult" ? 'contractHistory')
      OR JSONB_TYPEOF(
        OLD."affordabilityResult" -> 'contractHistory'
      ) = 'array'
    )
  THEN
    expected_review_affordability :=
      (
        OLD."affordabilityResult"
          - 'approval'
          - 'contract'
          - 'approvalHistory'
          - 'contractHistory'
      )
      || JSONB_BUILD_OBJECT(
        'approvalHistory',
        COALESCE(
          OLD."affordabilityResult" -> 'approvalHistory',
          '[]'::JSONB
        ) || JSONB_BUILD_ARRAY(
          OLD."affordabilityResult" -> 'approval'
        ),
        'contractHistory',
        COALESCE(
          OLD."affordabilityResult" -> 'contractHistory',
          '[]'::JSONB
        ) || JSONB_BUILD_ARRAY(
          OLD."affordabilityResult" -> 'contract'
        )
      );
  END IF;

  explicit_return_to_review := COALESCE((
    OLD."debitMandateSignedAt" IS NOT NULL
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."clientId" IS NOT DISTINCT FROM OLD."clientId"
    AND NEW."productId" IS NOT DISTINCT FROM OLD."productId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."appliedAmount" IS NOT DISTINCT FROM OLD."appliedAmount"
    AND NEW."appliedTermDays" IS NOT DISTINCT FROM OLD."appliedTermDays"
    AND NEW."purpose" IS NOT DISTINCT FROM OLD."purpose"
    AND NEW."agreementType" IS NOT DISTINCT FROM OLD."agreementType"
    AND NEW."initiationFeePayment"
      IS NOT DISTINCT FROM OLD."initiationFeePayment"
    AND NEW."assignedToId" IS NOT NULL
    AND LENGTH(BTRIM(NEW."assignedToId")) > 0
    AND NEW."approvedAt" IS NULL
    AND NEW."approvedById" IS NULL
    AND NEW."approvedAmount" IS NULL
    AND NEW."approvedTermDays" IS NULL
    AND NEW."approvedRate" IS NULL
    AND NEW."decisionReason" IS NULL
    AND expected_review_affordability IS NOT NULL
    AND NEW."affordabilityResult"
      IS NOT DISTINCT FROM expected_review_affordability
    AND NEW."bureauOverrideReason" IS NULL
    AND NEW."bureauOverrideById" IS NULL
    AND NEW."bureauOverrideAt" IS NULL
    AND NEW."bureauReviewGeneration" IS NOT NULL
    AND LENGTH(BTRIM(NEW."bureauReviewGeneration")) > 0
    AND NEW."bureauReviewGeneration"
      IS DISTINCT FROM OLD."bureauReviewGeneration"
    AND NEW."recklessLendingAssessed" = FALSE
    AND NEW."recklessLendingAssessedById" IS NULL
    AND NEW."recklessLendingAssessedAt" IS NULL
    AND NEW."pasqVersion" IS NULL
    AND NEW."pasqGeneratedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
    AND NEW."pasqEvidence" IS NULL
    AND NEW."pasqEvidenceSha256" IS NULL
    AND NEW."pasqAcknowledgedAt" IS NULL
    AND NEW."pasqAcknowledgedBy" IS NULL
    AND NEW."pasqAcknowledgedSha256" IS NULL
    AND NEW."approvedPasqDocumentSha256" IS NULL
    AND NEW."clientAffordabilityDeclaredAt" IS NULL
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementSignedMethod" IS NULL
    AND NEW."agreementSignedByIp" IS NULL
    AND NEW."agreementSignedByUserId" IS NULL
    AND NEW."agreementSignatureData" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."agreementCountersignedById" IS NULL
    AND NEW."agreementCountersignedByName" IS NULL
    AND NEW."agreementCountersignedByEmail" IS NULL
    AND NEW."agreementCountersignatureData" IS NULL
    AND NEW."agreementCountersignatureSha256" IS NULL
    AND NEW."agreementCountersignatureEnvelopeSha256" IS NULL
    AND NEW."agreementCountersignedDocumentSha256" IS NULL
    AND NEW."debitMandatePreparedAt" IS NULL
    AND NEW."debitMandateReference" IS NULL
    AND NEW."debitMandateDraftSha256" IS NULL
    AND NEW."debitMandateEvidence" IS NULL
    AND NEW."debitMandateEvidenceSha256" IS NULL
    AND NEW."debitMandateSignedAt" IS NULL
    AND NEW."debitMandateSignedMethod" IS NULL
    AND NEW."debitMandateSignedByIp" IS NULL
    AND NEW."debitMandateSignatureData" IS NULL
    AND NEW."debitMandateSignatureSha256" IS NULL
    AND NEW."debitMandateDocumentId" IS NULL
    AND NEW."debitMandateDocumentSha256" IS NULL
  ), FALSE);

  countersign_once := COALESCE((
    OLD."agreementSignedAt" IS NOT NULL
    AND OLD."agreementCountersignedAt" IS NULL
    AND OLD."agreementCountersignedById" IS NULL
    AND OLD."agreementCountersignedByName" IS NULL
    AND OLD."agreementCountersignedByEmail" IS NULL
    AND OLD."agreementCountersignatureData" IS NULL
    AND OLD."agreementCountersignatureSha256" IS NULL
    AND OLD."agreementCountersignatureEnvelopeSha256" IS NULL
    AND OLD."agreementCountersignedDocumentSha256" IS NULL
    AND NEW."agreementCountersignedAt" IS NOT NULL
  ), FALSE);

  IF OLD."debitMandateSignedAt" IS NOT NULL
    AND NOT explicit_return_to_review
    AND (
      NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."productId" IS DISTINCT FROM OLD."productId"
      OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
      OR NEW."appliedAmount" IS DISTINCT FROM OLD."appliedAmount"
      OR NEW."appliedTermDays" IS DISTINCT FROM OLD."appliedTermDays"
      OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
      OR NEW."agreementType" IS DISTINCT FROM OLD."agreementType"
      OR NEW."approvedAmount" IS DISTINCT FROM OLD."approvedAmount"
      OR NEW."approvedTermDays" IS DISTINCT FROM OLD."approvedTermDays"
      OR NEW."approvedRate" IS DISTINCT FROM OLD."approvedRate"
      OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
      OR NEW."decisionReason" IS DISTINCT FROM OLD."decisionReason"
      OR NEW."bureauOverrideReason"
        IS DISTINCT FROM OLD."bureauOverrideReason"
      OR NEW."bureauOverrideById"
        IS DISTINCT FROM OLD."bureauOverrideById"
      OR NEW."bureauOverrideAt" IS DISTINCT FROM OLD."bureauOverrideAt"
      OR NEW."bureauReviewGeneration"
        IS DISTINCT FROM OLD."bureauReviewGeneration"
      OR NEW."recklessLendingAssessed"
        IS DISTINCT FROM OLD."recklessLendingAssessed"
      OR NEW."recklessLendingAssessedById"
        IS DISTINCT FROM OLD."recklessLendingAssessedById"
      OR NEW."recklessLendingAssessedAt"
        IS DISTINCT FROM OLD."recklessLendingAssessedAt"
      OR NEW."clientAffordabilityDeclaredAt"
        IS DISTINCT FROM OLD."clientAffordabilityDeclaredAt"
      OR NEW."initiationFeePayment"
        IS DISTINCT FROM OLD."initiationFeePayment"
      OR NEW."affordabilityResult"
        IS DISTINCT FROM OLD."affordabilityResult"
      OR NEW."pasqVersion" IS DISTINCT FROM OLD."pasqVersion"
      OR NEW."pasqGeneratedAt" IS DISTINCT FROM OLD."pasqGeneratedAt"
      OR NEW."pasqDocumentId" IS DISTINCT FROM OLD."pasqDocumentId"
      OR NEW."pasqDocumentSha256"
        IS DISTINCT FROM OLD."pasqDocumentSha256"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
      OR NEW."pasqEvidenceSha256"
        IS DISTINCT FROM OLD."pasqEvidenceSha256"
      OR NEW."pasqAcknowledgedAt"
        IS DISTINCT FROM OLD."pasqAcknowledgedAt"
      OR NEW."pasqAcknowledgedBy"
        IS DISTINCT FROM OLD."pasqAcknowledgedBy"
      OR NEW."pasqAcknowledgedSha256"
        IS DISTINCT FROM OLD."pasqAcknowledgedSha256"
      OR NEW."approvedPasqDocumentSha256"
        IS DISTINCT FROM OLD."approvedPasqDocumentSha256"
      OR NEW."agreementGeneratedAt"
        IS DISTINCT FROM OLD."agreementGeneratedAt"
      OR NEW."agreementDocumentId"
        IS DISTINCT FROM OLD."agreementDocumentId"
      OR NEW."agreementDocumentSha256"
        IS DISTINCT FROM OLD."agreementDocumentSha256"
      OR NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
      OR NEW."agreementSignedMethod"
        IS DISTINCT FROM OLD."agreementSignedMethod"
      OR NEW."agreementSignedByIp"
        IS DISTINCT FROM OLD."agreementSignedByIp"
      OR NEW."agreementSignedByUserId"
        IS DISTINCT FROM OLD."agreementSignedByUserId"
      OR NEW."agreementSignatureData"
        IS DISTINCT FROM OLD."agreementSignatureData"
      -- The provider countersignature may be recorded once, NULL to value,
      -- after the borrower signed the mandate (either signing order is valid).
      -- Any other change to it stays frozen here.
      OR (
        NOT countersign_once
        AND (
          NEW."agreementCountersignedAt" IS DISTINCT FROM OLD."agreementCountersignedAt"
          OR NEW."agreementCountersignedById" IS DISTINCT FROM OLD."agreementCountersignedById"
          OR NEW."agreementCountersignedByName" IS DISTINCT FROM OLD."agreementCountersignedByName"
          OR NEW."agreementCountersignedByEmail" IS DISTINCT FROM OLD."agreementCountersignedByEmail"
          OR NEW."agreementCountersignatureData" IS DISTINCT FROM OLD."agreementCountersignatureData"
          OR NEW."agreementCountersignatureSha256" IS DISTINCT FROM OLD."agreementCountersignatureSha256"
          OR NEW."agreementCountersignatureEnvelopeSha256" IS DISTINCT FROM OLD."agreementCountersignatureEnvelopeSha256"
          OR NEW."agreementCountersignedDocumentSha256" IS DISTINCT FROM OLD."agreementCountersignedDocumentSha256"
        )
      )
      OR NEW."debitMandatePreparedAt"
        IS DISTINCT FROM OLD."debitMandatePreparedAt"
      OR NEW."debitMandateReference"
        IS DISTINCT FROM OLD."debitMandateReference"
      OR NEW."debitMandateDraftSha256"
        IS DISTINCT FROM OLD."debitMandateDraftSha256"
      OR NEW."debitMandateEvidence"
        IS DISTINCT FROM OLD."debitMandateEvidence"
      OR NEW."debitMandateEvidenceSha256"
        IS DISTINCT FROM OLD."debitMandateEvidenceSha256"
      OR NEW."debitMandateSignedAt"
        IS DISTINCT FROM OLD."debitMandateSignedAt"
      OR NEW."debitMandateSignedMethod"
        IS DISTINCT FROM OLD."debitMandateSignedMethod"
      OR NEW."debitMandateSignedByIp"
        IS DISTINCT FROM OLD."debitMandateSignedByIp"
      OR NEW."debitMandateSignatureData"
        IS DISTINCT FROM OLD."debitMandateSignatureData"
      OR NEW."debitMandateSignatureSha256"
        IS DISTINCT FROM OLD."debitMandateSignatureSha256"
      OR NEW."debitMandateDocumentId"
        IS DISTINCT FROM OLD."debitMandateDocumentId"
      OR NEW."debitMandateDocumentSha256"
        IS DISTINCT FROM OLD."debitMandateDocumentSha256"
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Signed debit-mandate authority is immutable outside an explicit return to review';
  END IF;

  RETURN NEW;
END;
$function$;

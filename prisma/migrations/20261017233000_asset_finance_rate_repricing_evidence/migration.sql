-- Ledger-only rates adjust a closed account separately until an active
-- schedule restatement consumes the pending correction without double credit.
CREATE FUNCTION public."assetRateIsLedgerOnly"(p_rate_id TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM "AssetFinanceRateCorrection" correction JOIN "ContractRate" rate ON rate."id" = correction."contractRateId"
    WHERE correction."contractRateId" = p_rate_id AND correction."reason" IN ('LATE_CLOSED_BOOK_RATE','FIXED_NOTICE_WINDOW_RATE','LATE_CLOSED_LEASE_RATE')
      AND NOT EXISTS (SELECT 1 FROM "AssetFinanceRateCorrection" applied JOIN "ContractRate" applied_rate ON applied_rate."id" = applied."contractRateId"
        WHERE applied."tenantId" = correction."tenantId" AND applied."loanId" = correction."loanId"
          AND applied."reason" = 'APPLIED_TO_SCHEDULE' AND applied_rate."effectiveDate" > rate."effectiveDate")
  );
END;
$$;

-- Authenticate a revised asset-finance contractual baseline without editing
-- the signed PASQ. Ordinary consumer LOAN contracts never enter this path.
CREATE OR REPLACE FUNCTION public."assetRateRepriceBaseline"(p_loan_id TEXT, p_original JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $function$
DECLARE
  booked RECORD;
  latest RECORD;
  baseline JSONB;
  expected JSONB;
  original_row JSONB;
  after_payoff BOOLEAN;
  ordinal BIGINT;
  previous_day DATE;
  due_day DATE;
  rate_days NUMERIC;
  expected_interest BIGINT;
  principal_sum BIGINT := 0;
  interest_sum BIGINT := 0;
  payment_sum BIGINT := 0;
  opening BIGINT;
  closing BIGINT;
  previous_closing BIGINT;
BEGIN
  SELECT l."tenantId", l."startDate", l."ncaRegime", l."contractType" INTO booked
  FROM "Loan" l WHERE l."id" = p_loan_id;
  IF NOT FOUND OR booked."ncaRegime" <> 'NCA' OR booked."contractType" NOT IN ('INSTALMENT_SALE', 'FINANCE_LEASE') THEN
    RETURN NULL;
  END IF;
  IF (SELECT COUNT(*) FROM "ContractRate" c WHERE c."loanId" = p_loan_id AND c."tenantId" = booked."tenantId" AND NOT public."assetRateIsLedgerOnly"(c."id")) < 2 THEN
    RETURN NULL;
  END IF;
  SELECT c.* INTO latest FROM "ContractRate" c
  WHERE c."loanId" = p_loan_id AND c."tenantId" = booked."tenantId" AND NOT public."assetRateIsLedgerOnly"(c."id")
  ORDER BY c."effectiveDate" DESC LIMIT 1;
  SELECT a."newValue" -> 'assetRateRepriceEvidence' INTO baseline FROM "AuditLog" a
  WHERE a."tenantId" = booked."tenantId" AND a."entity" = 'Loan' AND a."entityId" = p_loan_id
    AND a."action" = 'LOAN_REPRICED' AND a."newValue" ->> 'contractRateId' = latest."id"
    AND a."newValue" #>> '{assetRateRepriceEvidence,contractRateId}' = latest."id"
  ORDER BY a."createdAt" DESC, a."id" DESC LIMIT 1;
  IF baseline IS NULL OR baseline ->> 'version' IS DISTINCT FROM 'asset-rate-reprice-v1'
    OR baseline ->> 'originalEvidenceSha256' IS DISTINCT FROM p_original ->> 'evidenceSha256'
    OR baseline ->> 'effectiveDate' IS DISTINCT FROM latest."effectiveDate"::TEXT
    OR (CASE WHEN baseline ->> 'annualRate' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (baseline ->> 'annualRate')::NUMERIC IS DISTINCT FROM latest."resultingRate" ELSE TRUE END)
    OR JSONB_TYPEOF(baseline -> 'rows') IS DISTINCT FROM 'array'
    OR JSONB_ARRAY_LENGTH(baseline -> 'rows') <> JSONB_ARRAY_LENGTH(p_original #> '{billing,schedule}')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset rate repricing needs authentic contractual baseline evidence';
  END IF;
  -- The immutable ContractRate guard binds every point to its approved
  -- reference and the agreement's unchanged margin. Check the current point
  -- again so an audit marker alone is never approval evidence.
  IF latest."basis" = 'FIXED' OR NOT EXISTS (
    SELECT 1 FROM "ReferenceRate" r WHERE r."tenantId" = booked."tenantId" AND r."basis" = latest."basis"
      AND r."status" = 'APPROVED' AND r."effectiveDate" <= latest."effectiveDate"
      AND r."rate" + latest."margin" = latest."resultingRate"
      AND NOT EXISTS (SELECT 1 FROM "ReferenceRate" newer WHERE newer."tenantId" = r."tenantId"
        AND newer."basis" = r."basis" AND newer."status" = 'APPROVED'
        AND newer."effectiveDate" > r."effectiveDate" AND newer."effectiveDate" <= latest."effectiveDate")
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset rate repricing needs its approved reference-rate path';
  END IF;
  previous_day := (booked."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE;
  FOR expected, ordinal IN SELECT value, ordinality FROM JSONB_ARRAY_ELEMENTS(baseline -> 'rows') WITH ORDINALITY LOOP
    original_row := p_original #> ARRAY['billing', 'schedule', (ordinal - 1)::TEXT];
    after_payoff := baseline ? 'payoff' AND ((expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'Africa/Johannesburg')::DATE > (baseline #>> '{payoff,date}')::DATE;
    IF expected ->> 'installmentNo' IS DISTINCT FROM original_row ->> 'installmentNo'
      OR expected ->> 'dueDate' IS DISTINCT FROM original_row ->> 'dueDate'
      OR (NOT COALESCE(after_payoff,FALSE) AND (expected ->> 'feesDueCents' IS DISTINCT FROM original_row ->> 'feesDueCents' OR expected ->> 'baseFeesDueCents' IS DISTINCT FROM original_row ->> 'baseFeesDueCents' OR expected ->> 'creditLifePremiumDueCents' IS DISTINCT FROM original_row ->> 'creditLifePremiumDueCents'))
      OR (after_payoff AND ((expected ->> 'totalDueCents')::BIGINT <> 0 OR (expected ->> 'feesDueCents')::BIGINT <> 0 OR (expected ->> 'creditLifePremiumDueCents')::BIGINT <> 0))
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['principalDueCents','interestDueCents','totalDueCents','openingBalanceCents','closingBalanceCents']) key
        WHERE NOT COALESCE(expected ->> key ~ '^[0-9]+$', FALSE))
      OR (expected ->> 'totalDueCents')::BIGINT <> (expected ->> 'principalDueCents')::BIGINT
        + (expected ->> 'interestDueCents')::BIGINT + (expected ->> 'feesDueCents')::BIGINT
      OR NOT EXISTS (SELECT 1 FROM "RepaymentSchedule" s WHERE s."id" = expected ->> 'id'
        AND s."loanId" = p_loan_id AND s."tenantId" = booked."tenantId"
        AND s."installmentNo" = (expected ->> 'installmentNo')::INTEGER)
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing preserves signed dates, fees, premiums and row identities';
    END IF;
    opening := (expected ->> 'openingBalanceCents')::BIGINT;
    closing := (expected ->> 'closingBalanceCents')::BIGINT;
    IF (ordinal = 1 AND opening <> (p_original #>> '{calculator,principalCents}')::BIGINT)
      OR (ordinal > 1 AND opening IS DISTINCT FROM previous_closing)
      OR closing <> opening - (expected ->> 'principalDueCents')::BIGINT
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing must preserve the interest-bearing principal without capitalising fees or interest';
    END IF;
    due_day := ((expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'Africa/Johannesburg')::DATE;
    SELECT COALESCE(SUM(path."resultingRate" * GREATEST(0,
      LEAST(COALESCE(path.next_day - 1, due_day), due_day) - GREATEST(path."effectiveDate", previous_day + 1) + 1)), 0)
    INTO rate_days FROM (
      SELECT c."effectiveDate", c."resultingRate", LEAD(c."effectiveDate") OVER (ORDER BY c."effectiveDate") AS next_day
      FROM "ContractRate" c WHERE c."loanId" = p_loan_id AND c."tenantId" = booked."tenantId" AND NOT public."assetRateIsLedgerOnly"(c."id")
    ) path;
    expected_interest := ROUND(opening * rate_days / 365)::BIGINT;
    IF (expected ->> 'interestDueCents')::BIGINT <> expected_interest THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing interest must follow the approved path from each effective day';
    END IF;
    previous_day := due_day;
    previous_closing := closing;
    principal_sum := principal_sum + (expected ->> 'principalDueCents')::BIGINT;
    interest_sum := interest_sum + expected_interest;
    payment_sum := payment_sum + (expected ->> 'totalDueCents')::BIGINT;
  END LOOP;
  IF previous_closing <> 0 OR principal_sum <> (p_original #>> '{calculator,principalCents}')::BIGINT
    OR interest_sum <> (baseline ->> 'totalInterestCents')::BIGINT
    OR payment_sum <> (baseline ->> 'totalRepayableCents')::BIGINT THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Asset repricing baseline totals must reconcile to its contractual rows';
  END IF;
  IF baseline ? 'payoff' AND (
    NOT EXISTS (SELECT 1 FROM "AssetFinanceRateCorrection" correction WHERE correction."contractRateId" = latest."id" AND correction."reason" = 'RATE_PAYOFF_CREDIT')
    OR (baseline #>> '{payoff,refundDueCents}')::BIGINT <> (SELECT COALESCE(SUM(p."amount"),0) FROM "Payment" p WHERE p."tenantId" = booked."tenantId" AND p."loanId" = p_loan_id AND NOT p."reversed" AND p."allocationStatus" = 'UNAPPLIED' AND p."reconciliationReason" = 'asset_rate_payoff_credit' AND p."reconciliationReference" = latest."id")
  ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Rate payoff needs its conserved pending cash refund'; END IF;
  RETURN baseline;
END;
$function$;

-- Raw request metadata on another audit action cannot forge the monetary
-- evidence consumed by the deferred PASQ guard.
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_asset_rate_evidence_action" CHECK (
  NOT COALESCE("newValue" ? 'assetRateRepriceEvidence', FALSE)
  OR ("action" = 'LOAN_REPRICED' AND "entity" = 'Loan' AND "entityId" IS NOT NULL
    AND JSONB_TYPEOF("newValue" -> 'assetRateRepriceEvidence') = 'object')
);

-- Existing consumer validator, unchanged outside the asset-only prelude.
CREATE OR REPLACE FUNCTION public."validateLoanPasqV3Billing"(p_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  booked RECORD;
  expected_schedule_count INTEGER;
  evidence_total_interest INTEGER;
  evidence_total_repayable INTEGER;
  actual_schedule_count INTEGER;
  actual_total_due BIGINT;
  actual_premium_due BIGINT;
  allocated_payment_total BIGINT;
  early_daily_settlement BOOLEAN;
  early_instalment_settlement BOOLEAN;
  actual_total_interest BIGINT;
  settled RECORD;
  revised_asset_baseline JSONB;
  settle_day DATE;
BEGIN
  SELECT
    loan."id",
    loan."tenantId",
    loan."ncaRegime",
    loan."contractType",
    loan."applicationId",
    loan."clientId",
    loan."productId",
    loan."principal",
    loan."totalInterest",
    loan."initiationFee",
    loan."creditLifePremiums",
    loan."totalRepayable",
    loan."contractualTotalInterest",
    loan."contractualTotalRepayable",
    loan."totalPaid",
    loan."outstandingPrincipal",
    loan."status",
    loan."closedAt",
    loan."interestModel",
    application."pasqVersion",
    application."pasqEvidence"
  INTO booked
  FROM "Loan" AS loan
  JOIN "LoanApplication" AS application
    ON application."id" = loan."applicationId"
  WHERE loan."id" = p_loan_id;

  IF NOT FOUND OR booked."pasqVersion" IS DISTINCT FROM 'pasq-v3' THEN
    RETURN;
  END IF;

  -- NCA asset contracts alone may have an authenticated reference repricing.
  -- The signed PASQ is never updated. Its revised contractual money is used
  -- locally below by the unchanged normal / s125 / reversal checks.
  IF booked."ncaRegime" = 'NCA' AND booked."contractType" IN ('INSTALMENT_SALE', 'FINANCE_LEASE') THEN
    revised_asset_baseline := public."assetRateRepriceBaseline"(booked."id", booked."pasqEvidence");
    IF revised_asset_baseline IS NOT NULL THEN
      booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{calculator,totalInterestCents}', revised_asset_baseline -> 'totalInterestCents');
      booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{billing,totalRepayableCents}', revised_asset_baseline -> 'totalRepayableCents');
      booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{billing,schedule}', revised_asset_baseline -> 'rows');
      IF revised_asset_baseline ? 'payoff' THEN
        SELECT COALESCE(SUM((item ->> 'creditLifePremiumDueCents')::BIGINT),0) INTO booked."creditLifePremiums" FROM JSONB_ARRAY_ELEMENTS(revised_asset_baseline -> 'rows') item;
        booked."pasqEvidence" := JSONB_SET(booked."pasqEvidence", '{creditLife,totalPremiumCents}', TO_JSONB(booked."creditLifePremiums"));
      END IF;
    END IF;
  END IF;

  IF
    JSONB_TYPEOF(booked."pasqEvidence") <> 'object'
    OR JSONB_TYPEOF(booked."pasqEvidence" #> '{billing,schedule}') <> 'array'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  evidence_total_interest :=
    (booked."pasqEvidence" #>> '{calculator,totalInterestCents}')::INTEGER;
  evidence_total_repayable :=
    (booked."pasqEvidence" #>> '{billing,totalRepayableCents}')::INTEGER;
  expected_schedule_count :=
    JSONB_ARRAY_LENGTH(booked."pasqEvidence" #> '{billing,schedule}');

  IF
    booked."tenantId" <> booked."pasqEvidence" ->> 'tenantId'
    OR booked."applicationId" <> booked."pasqEvidence" ->> 'applicationId'
    OR booked."clientId" <> booked."pasqEvidence" ->> 'clientId'
    OR booked."productId" <> booked."pasqEvidence" ->> 'productId'
    OR booked."principal"
      <> (booked."pasqEvidence" #>> '{calculator,principalCents}')::INTEGER
    OR booked."initiationFee"
      <> (booked."pasqEvidence" #>> '{calculator,initiationFeeCents}')::INTEGER
    OR booked."creditLifePremiums"
      <> (booked."pasqEvidence" #>> '{creditLife,totalPremiumCents}')::INTEGER
    OR (
      booked."contractualTotalInterest" IS NOT NULL
      AND booked."contractualTotalInterest" <> evidence_total_interest
    )
    OR (
      booked."contractualTotalRepayable" IS NOT NULL
      AND booked."contractualTotalRepayable" <> evidence_total_repayable
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  early_daily_settlement :=
    booked."status" = 'COMPLETED'::"LoanStatus"
    AND booked."interestModel" = 'DAILY_ACCRUAL'::"InterestModel"
    AND booked."contractualTotalInterest" = evidence_total_interest
    AND booked."contractualTotalRepayable" = evidence_total_repayable
    AND booked."totalInterest" < evidence_total_interest
    AND booked."totalRepayable" < evidence_total_repayable;

  SELECT
    COUNT(*)::INTEGER,
    COALESCE(SUM(schedule."totalDue"), 0),
    COALESCE(SUM(schedule."creditLifePremiumDue"), 0)
  INTO actual_schedule_count, actual_total_due, actual_premium_due
  FROM "RepaymentSchedule" AS schedule
  WHERE schedule."loanId" = booked."id";

  IF early_daily_settlement THEN
    SELECT COALESCE(SUM(payment."amount"), 0)
    INTO allocated_payment_total
    FROM "Payment" AS payment
    WHERE payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus" = 'ALLOCATED'::"PaymentAllocationStatus";

    IF
      expected_schedule_count <> 1
      OR actual_schedule_count <> 1
      OR booked."totalInterest" < 0
      OR booked."totalRepayable"
        <> evidence_total_repayable
          - evidence_total_interest
          + booked."totalInterest"
      OR booked."totalPaid" <> booked."totalRepayable"
      OR allocated_payment_total <> booked."totalPaid"
      OR booked."outstandingPrincipal" <> 0
      OR booked."closedAt" IS NULL
      OR actual_total_due <> booked."totalRepayable"
      OR actual_premium_due <> booked."creditLifePremiums"
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        LEFT JOIN "RepaymentSchedule" AS actual
          ON actual."loanId" = booked."id"
          AND actual."installmentNo"
            = (expected ->> 'installmentNo')::INTEGER
        WHERE
          actual."id" IS NULL
          OR actual."tenantId" <> booked."tenantId"
          OR actual."principalDue"
            <> (expected ->> 'principalDueCents')::INTEGER
          OR actual."interestDue" <> booked."totalInterest"
          OR actual."creditLifePremiumDue"
            <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
          OR actual."feesDue"
            <> (expected ->> 'feesDueCents')::INTEGER
          OR actual."totalDue" <> booked."totalRepayable"
          OR actual."totalPaid" <> actual."totalDue"
          OR actual."status" <> 'PAID'::"ScheduleStatus"
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "Payment" AS payment
        JOIN "AuditLog" AS audit
          ON audit."tenantId" = booked."tenantId"
          AND (
            audit."newValue" ->> 'paymentId' = payment."id"
            OR (
              audit."entity" = 'Payment'
              AND audit."entityId" = payment."id"
            )
          )
        WHERE payment."loanId" = booked."id"
          AND payment."tenantId" = booked."tenantId"
          AND payment."reversed" = FALSE
          AND payment."allocationStatus"
            = 'ALLOCATED'::"PaymentAllocationStatus"
          AND audit."newValue" ->> 'earlyDailySettlement' = 'true'
          AND CASE
            WHEN audit."newValue" ->> 'accruedInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'accruedInterest')::BIGINT
          END = booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'interestRebate' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'interestRebate')::BIGINT
          END = evidence_total_interest - booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'resultingTotalInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'resultingTotalInterest')::BIGINT
          END = booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'resultingTotalRepayable' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'resultingTotalRepayable')::BIGINT
          END = booked."totalRepayable"
          AND CASE
            WHEN audit."newValue" ->> 'contractualTotalInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'contractualTotalInterest')::BIGINT
          END = evidence_total_interest
          AND CASE
            WHEN audit."newValue" ->> 'contractualTotalRepayable' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'contractualTotalRepayable')::BIGINT
          END = evidence_total_repayable
          AND CASE
            WHEN audit."newValue" ->> 'settlementDue' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'settlementDue')::BIGINT
          END = payment."amount"
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early DAILY_ACCRUAL settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;
    RETURN;
  END IF;

  -- NCA s125 early settlement of an instalment agreement
  -- (lib/loan/s125-settlement.ts): rows not yet due at the settlement date are
  -- re-priced down to what they earned (principal, pro-rata interest of the
  -- current period, a deferred initiation fee) and the loan closes.
  --
  -- The settlement is the receipt a receipt writer's audit row names: a live,
  -- allocated payment on this loan whose amount is the settlement figure the
  -- row records, and whose row records the contractual rows it re-priced,
  -- which match the PASQ exactly (a reversal restores the schedule from them).
  -- The settlement date is that payment's value date: every row due by then is
  -- owed exactly as acknowledged; of the rows after it only the first carries
  -- interest, none carries a premium or a fee but the deferred initiation fee
  -- in instalment 1, and nothing rises above the PASQ.
  early_instalment_settlement :=
    booked."status" = 'COMPLETED'::"LoanStatus"
    AND booked."interestModel" <> 'DAILY_ACCRUAL'::"InterestModel"
    AND expected_schedule_count > 1
    AND booked."contractualTotalInterest" = evidence_total_interest
    AND booked."contractualTotalRepayable" = evidence_total_repayable
    AND booked."totalRepayable" < evidence_total_repayable;

  IF early_instalment_settlement THEN
    SELECT payment."id", payment."receivedAt"
    INTO settled
    FROM "AuditLog" AS audit
    JOIN "Payment" AS payment
      ON payment."id" = audit."newValue" ->> 'paymentId'
      AND payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus"
        = 'ALLOCATED'::"PaymentAllocationStatus"
    WHERE audit."tenantId" = booked."tenantId"
      AND (
        (
          audit."action" IN ('PAYMENT_RECORDED', 'SMALL_BALANCE_WAIVED')
          AND audit."entity" = 'Loan'
          AND audit."entityId" = booked."id"
        )
        OR (
          audit."action" = 'PAYMENT_ALLOCATED'
          AND audit."entity" = 'Payment'
          AND audit."entityId" = payment."id"
        )
        OR (
          audit."action" = 'BANK_TXN_RECONCILED'
          AND audit."entity" = 'BankTransaction'
          AND EXISTS (
            SELECT 1
            FROM "BankTransaction" AS deposit
            WHERE deposit."id" = audit."entityId"
              AND deposit."tenantId" = booked."tenantId"
              AND deposit."paymentId" = payment."id"
          )
        )
      )
      AND audit."newValue" ->> 'earlyInstalmentSettlement' = 'true'
      AND audit."newValue" ->> 'loanId' = booked."id"
      AND CASE
        WHEN audit."newValue" ->> 'settlementDue' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'settlementDue')::BIGINT
      END = payment."amount"
      AND CASE
        WHEN audit."newValue" ->> 'resultingTotalInterest' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'resultingTotalInterest')::BIGINT
      END = booked."totalInterest"
      AND CASE
        WHEN audit."newValue" ->> 'resultingTotalRepayable' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'resultingTotalRepayable')::BIGINT
      END = booked."totalRepayable"
      AND CASE
        WHEN audit."newValue" ->> 'interestRebate' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'interestRebate')::BIGINT
      END = evidence_total_interest - booked."totalInterest"
      AND CASE
        WHEN audit."newValue" ->> 'contractualTotalInterest' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'contractualTotalInterest')::BIGINT
      END = evidence_total_interest
      AND CASE
        WHEN audit."newValue" ->> 'contractualTotalRepayable' ~ '^[0-9]+$'
        THEN (audit."newValue" ->> 'contractualTotalRepayable')::BIGINT
      END = evidence_total_repayable
      AND JSONB_TYPEOF(audit."newValue" -> 'contractualRows') = 'array'
      AND JSONB_ARRAY_LENGTH(audit."newValue" -> 'contractualRows')
        = expected_schedule_count
      AND NOT EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        WHERE NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            audit."newValue" -> 'contractualRows'
          ) AS recorded
          JOIN "RepaymentSchedule" AS own
            ON own."id" = recorded ->> 'id'
            AND own."loanId" = booked."id"
            AND own."installmentNo"
              = (expected ->> 'installmentNo')::INTEGER
          WHERE recorded ->> 'installmentNo' = expected ->> 'installmentNo'
            AND recorded ->> 'principalDue' = expected ->> 'principalDueCents'
            AND recorded ->> 'interestDue' = expected ->> 'interestDueCents'
            AND recorded ->> 'feesDue' = expected ->> 'feesDueCents'
            AND recorded ->> 'creditLifePremiumDue'
              = expected ->> 'creditLifePremiumDueCents'
            AND recorded ->> 'totalDue' = expected ->> 'totalDueCents'
        )
      )
    ORDER BY audit."createdAt" DESC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;

    settle_day :=
      (settled."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE;

    SELECT COALESCE(SUM(
      payment."amount" - payment."defaultInterestAllocated" - payment."chargeFeesAllocated"
    ), 0)
    INTO allocated_payment_total
    FROM "Payment" AS payment
    WHERE payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus" = 'ALLOCATED'::"PaymentAllocationStatus";

    SELECT COALESCE(SUM(schedule."interestDue"), 0)
    INTO actual_total_interest
    FROM "RepaymentSchedule" AS schedule
    WHERE schedule."loanId" = booked."id";

    IF
      actual_schedule_count <> expected_schedule_count
      OR booked."totalInterest" < 0
      OR actual_total_interest <> booked."totalInterest"
      OR actual_total_due <> booked."totalRepayable"
      OR booked."totalPaid" <> booked."totalRepayable"
      OR allocated_payment_total <> booked."totalPaid"
      OR booked."outstandingPrincipal" <> 0
      OR booked."closedAt" IS NULL
      OR actual_premium_due > booked."creditLifePremiums"
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        LEFT JOIN "RepaymentSchedule" AS actual
          ON actual."loanId" = booked."id"
          AND actual."installmentNo"
            = (expected ->> 'installmentNo')::INTEGER
        WHERE
          actual."id" IS NULL
          OR actual."tenantId" <> booked."tenantId"
          OR actual."principalDue"
            <> (expected ->> 'principalDueCents')::INTEGER
          OR actual."totalDue"
            <> actual."principalDue" + actual."interestDue" + actual."feesDue"
          OR actual."totalPaid" <> actual."totalDue"
          OR actual."status" <> 'PAID'::"ScheduleStatus"
          OR CASE
            WHEN (actual."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE
              <= settle_day
            THEN
              actual."interestDue"
                <> (expected ->> 'interestDueCents')::INTEGER
              OR actual."feesDue"
                <> (expected ->> 'feesDueCents')::INTEGER
              OR actual."creditLifePremiumDue"
                <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
            ELSE
              actual."creditLifePremiumDue" <> 0
              OR actual."feesDue" < 0
              OR actual."feesDue" > CASE
                WHEN actual."installmentNo" = 1
                THEN LEAST(
                  booked."initiationFee",
                  (expected ->> 'feesDueCents')::INTEGER
                )
                ELSE 0
              END
              OR actual."interestDue" < 0
              OR actual."interestDue"
                > (expected ->> 'interestDueCents')::INTEGER
              OR (
                actual."interestDue" > 0
                AND EXISTS (
                  SELECT 1
                  FROM "RepaymentSchedule" AS earlier
                  WHERE earlier."loanId" = booked."id"
                    AND earlier."installmentNo" < actual."installmentNo"
                    AND (earlier."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::DATE
                      > settle_day
                )
              )
          END
      )
      OR EXISTS (
        SELECT 1
        FROM "RepaymentSchedule" AS actual
        WHERE actual."loanId" = booked."id"
          AND NOT EXISTS (
            SELECT 1
            FROM JSONB_ARRAY_ELEMENTS(
              booked."pasqEvidence" #> '{billing,schedule}'
            ) AS expected
            WHERE (expected ->> 'installmentNo')::INTEGER
              = actual."installmentNo"
          )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;
    RETURN;
  END IF;

  IF
    booked."totalInterest" <> evidence_total_interest
    OR booked."totalRepayable" <> evidence_total_repayable
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  IF
    actual_schedule_count <> expected_schedule_count
    OR actual_total_due <> booked."totalRepayable"
    OR actual_premium_due <> booked."creditLifePremiums"
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(
        booked."pasqEvidence" #> '{billing,schedule}'
      ) AS expected
      LEFT JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo"
          = (expected ->> 'installmentNo')::INTEGER
      WHERE
        actual."id" IS NULL
        OR actual."tenantId" <> booked."tenantId"
        OR actual."principalDue"
          <> (expected ->> 'principalDueCents')::INTEGER
        OR actual."interestDue"
          <> (expected ->> 'interestDueCents')::INTEGER
        OR actual."creditLifePremiumDue"
          <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
        OR actual."feesDue"
          <> (expected ->> 'feesDueCents')::INTEGER
        OR actual."totalDue"
          <> (expected ->> 'totalDueCents')::INTEGER
    )
    OR EXISTS (
      SELECT 1
      FROM "RepaymentSchedule" AS actual
      WHERE actual."loanId" = booked."id"
        AND NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            booked."pasqEvidence" #> '{billing,schedule}'
          ) AS expected
          WHERE (expected ->> 'installmentNo')::INTEGER
            = actual."installmentNo"
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Repayment schedule does not match the acknowledged PASQ v3 billing evidence';
  END IF;
END;

$function$;

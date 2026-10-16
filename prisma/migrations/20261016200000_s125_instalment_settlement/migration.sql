-- ---------------------------------------------------------------------------
-- Hand-written: NCA s125 early settlement of an instalment agreement
-- ---------------------------------------------------------------------------
--
-- validateLoanPasqV3Billing (baseline) refuses any loan or schedule money that
-- differs from the acknowledged PASQ v3 billing evidence, except the early
-- DAILY_ACCRUAL bullet rebate. A consumer settling a multi-instalment loan early
-- owes only what s125(2) allows (lib/loan/s125-settlement.ts), so the receipt
-- that settles it re-prices the instalments not yet due and closes the loan.
-- This re-creates the function with an early-instalment-settlement branch:
-- checked against the PASQ evidence and against the audit row the settlement
-- receipt writes, which records the contractual rows it re-priced. Everything
-- else in the function is unchanged. Proven against a migrated database by
-- lib/loan/s125-settlement.integration.test.ts.

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
BEGIN
  SELECT
    loan."id",
    loan."tenantId",
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
  -- current period, a deferred initiation fee) and the loan closes. Every
  -- principal still matches the acknowledged PASQ, no interest, fee or premium
  -- rises above it, the ledger balances, and an audit row written with the
  -- settlement receipt records the contractual rows it re-priced, which match
  -- the PASQ exactly: a reversal restores the schedule from them.
  early_instalment_settlement :=
    booked."status" = 'COMPLETED'::"LoanStatus"
    AND booked."interestModel" <> 'DAILY_ACCRUAL'::"InterestModel"
    AND expected_schedule_count > 1
    AND booked."contractualTotalInterest" = evidence_total_interest
    AND booked."contractualTotalRepayable" = evidence_total_repayable
    AND booked."totalRepayable" < evidence_total_repayable;

  IF early_instalment_settlement THEN
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
          OR actual."interestDue" < 0
          OR actual."interestDue"
            > (expected ->> 'interestDueCents')::INTEGER
          OR actual."creditLifePremiumDue" < 0
          OR actual."creditLifePremiumDue"
            > (expected ->> 'creditLifePremiumDueCents')::INTEGER
          OR actual."feesDue"
            > (expected ->> 'feesDueCents')::INTEGER
          OR actual."creditLifePremiumDue" > actual."feesDue"
          OR actual."totalDue"
            <> actual."principalDue" + actual."interestDue" + actual."feesDue"
          OR actual."totalPaid" <> actual."totalDue"
          OR actual."status" <> 'PAID'::"ScheduleStatus"
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
      OR NOT EXISTS (
        SELECT 1
        FROM "AuditLog" AS audit
        JOIN "Payment" AS payment
          ON payment."id" = audit."newValue" ->> 'paymentId'
          AND payment."loanId" = booked."id"
          AND payment."tenantId" = booked."tenantId"
          AND payment."reversed" = FALSE
          AND payment."allocationStatus"
            = 'ALLOCATED'::"PaymentAllocationStatus"
        WHERE audit."tenantId" = booked."tenantId"
          AND audit."newValue" ->> 'earlyInstalmentSettlement' = 'true'
          AND audit."newValue" ->> 'loanId' = booked."id"
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
              WHERE recorded ->> 'installmentNo' = expected ->> 'installmentNo'
                AND recorded ->> 'principalDue' = expected ->> 'principalDueCents'
                AND recorded ->> 'interestDue' = expected ->> 'interestDueCents'
                AND recorded ->> 'feesDue' = expected ->> 'feesDueCents'
                AND recorded ->> 'creditLifePremiumDue'
                  = expected ->> 'creditLifePremiumDueCents'
                AND recorded ->> 'totalDue' = expected ->> 'totalDueCents'
            )
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

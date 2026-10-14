-- Asset-finance PASQ evidence signs SAST calendar dates. Unlike the consumer
-- calculator, its schedule is not rebased by the time of day at which the
-- agreement PDF is generated. Keep the existing consumer branch unchanged.
CREATE OR REPLACE FUNCTION public."validateLoanPasqV3ScheduleDates"(p_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  booked RECORD;
  quote_start_utc TIMESTAMP(3);
  quote_start_tz TIMESTAMPTZ;
  agreement_start_utc TIMESTAMP(3);
  agreement_offset INTERVAL;
  payout_offset INTERVAL;
  total_offset INTERVAL;
  agreement_sast_date DATE;
  payout_sast_date DATE;
  expected_maturity_utc TIMESTAMP(3);
BEGIN
  SELECT
    loan."id",
    loan."tenantId",
    loan."startDate",
    loan."maturityDate",
    application."pasqVersion",
    application."pasqEvidence",
    application."agreementGeneratedAt",
    application."repaymentMethod",
    EXISTS (
      SELECT 1 FROM "AssetFinanceDeal" AS deal
      WHERE deal."applicationId" = application."id"
        AND deal."tenantId" = loan."tenantId"
    ) AS "isAssetFinance"
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
    OR booked."agreementGeneratedAt" IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PASQ v3 schedule date evidence is missing or invalid';
  END IF;

  quote_start_tz := (booked."pasqEvidence" #>> '{calculator,startDate}')::TIMESTAMPTZ;
  quote_start_utc := quote_start_tz AT TIME ZONE 'UTC';
  agreement_start_utc := booked."agreementGeneratedAt";
  agreement_offset := agreement_start_utc - quote_start_utc;

  agreement_sast_date := (
    booked."agreementGeneratedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg'
  )::DATE;
  payout_sast_date := (
    booked."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg'
  )::DATE;

  IF booked."isAssetFinance" THEN
    -- The asset quote and agreement display the evidence's calendar dates;
    -- booking must reproduce those dates exactly, irrespective of PDF time.
    payout_offset := INTERVAL '0 milliseconds';
    total_offset := INTERVAL '0 milliseconds';
  ELSE
    IF booked."repaymentMethod" = 'EFT' THEN
      payout_offset := (payout_sast_date - agreement_sast_date) * INTERVAL '1 day';
    ELSE
      payout_offset := INTERVAL '0 milliseconds';
    END IF;
    total_offset := agreement_offset + payout_offset;
  END IF;

  SELECT (((expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'UTC') + total_offset)
  INTO expected_maturity_utc
  FROM JSONB_ARRAY_ELEMENTS(booked."pasqEvidence" #> '{billing,schedule}') AS expected
  ORDER BY (expected ->> 'installmentNo')::INTEGER DESC
  LIMIT 1;

  IF
    agreement_offset < INTERVAL '0 milliseconds'
    OR payout_offset < INTERVAL '0 milliseconds'
    OR agreement_sast_date > "quoteValidUntilDate"(quote_start_tz)
    OR payout_sast_date > "quoteValidUntilDate"(quote_start_tz)
    OR (
      NOT booked."isAssetFinance"
      AND booked."repaymentMethod" IS DISTINCT FROM 'EFT'
      AND payout_sast_date <> agreement_sast_date
    )
    OR expected_maturity_utc IS NULL
    OR booked."maturityDate" <> expected_maturity_utc
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(booked."pasqEvidence" #> '{billing,schedule}') AS expected
      LEFT JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo" = (expected ->> 'installmentNo')::INTEGER
      WHERE actual."id" IS NULL
        OR actual."dueDate" <> (
          ((expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'UTC') + total_offset
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Repayment schedule dates do not match the PASQ v3 quote window and signed agreement';
  END IF;
END;
$function$;

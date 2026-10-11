import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { describe, expect, it } from "vitest"
import {
  createDebitMandateEvidence,
  debitMandateContractTerms,
  debitMandateBankDetailsSha256,
  debitMandateEvidenceSha256,
  maskDebitMandateAccountNumber,
  sha256DebitMandateValue,
  verifiedBankStatementEvidence,
  verifyStoredDebitMandatePreparation,
  verifyStoredSignedDebitMandate,
  type DebitMandateExpectedEvidence,
} from "./debit-mandate"
import { createDebitMandateTestEvidence } from "@/lib/loan/__fixtures__/debit-mandate"
import { createPasqEvidence } from "@/lib/compliance/pasq"
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"

const preparedAt = new Date("2026-07-23T12:00:00.000Z")
const agreementSignedAt = new Date("2026-07-23T11:45:00.000Z")
const signedAt = new Date("2026-07-23T12:05:00.000Z")
const bankDetails = {
  bankName: "FNB (First National Bank)",
  branchCode: "250655",
  accountNumber: "62012345678",
  accountType: "CHEQUE" as const,
}
const expected: DebitMandateExpectedEvidence = {
  applicationId: "application-1",
  clientId: "client-1",
  contractFingerprint: "contract-fingerprint",
  bankDetails,
  bankStatement: {
    documentId: "statement-1",
    documentSha256: "a".repeat(64),
    verifiedAt: "2026-07-23T10:00:00.000Z",
  },
  terms: {
    paymentFrequency: "MONTHLY",
    recurringDebitAmountCents: 232_945,
    firstDebitAmountCents: 274_920,
    firstDebitDate: "2026-08-23T12:00:00.000Z",
    firstDebitInitiationFeeCents: 41_975,
  },
}

function prepared() {
  const evidence = createDebitMandateEvidence({
    ...expected,
    collectionReference: "LN-TEST-001",
    preparedAt,
  })
  return {
    debitMandatePreparedAt: preparedAt,
    debitMandateReference: "LN-TEST-001",
    debitMandateDraftSha256: "b".repeat(64),
    debitMandateEvidence: evidence,
    debitMandateEvidenceSha256: debitMandateEvidenceSha256(evidence),
  }
}

function signed() {
  const signature = "Synthetic Client"
  return {
    ...prepared(),
    agreementSignedAt,
    debitMandateSignedAt: signedAt,
    debitMandateSignedMethod: "portal",
    debitMandateSignatureData: signature,
    debitMandateSignatureSha256: sha256DebitMandateValue(signature),
    debitMandateDocumentId: "mandate-1",
    debitMandateDocumentSha256: "c".repeat(64),
  }
}

describe("debit-mandate evidence", () => {
  it("normalises banking before fingerprinting and masks all but four digits", () => {
    expect(debitMandateBankDetailsSha256(bankDetails)).toBe(
      debitMandateBankDetailsSha256({
        ...bankDetails,
        bankName: "  fnb (first   national bank) ",
        branchCode: "250 655",
        accountNumber: "620-1234-5678",
      }),
    )
    expect(maskDebitMandateAccountNumber(bankDetails.accountNumber)).toBe("*******5678")
  })

  it("accepts exact prepared evidence and rejects a changed bank account", () => {
    expect(verifyStoredDebitMandatePreparation(prepared(), expected)).toEqual(
      expect.objectContaining({ ok: true, draftDocumentSha256: "b".repeat(64) }),
    )
    expect(verifyStoredDebitMandatePreparation(prepared(), {
      ...expected,
      bankDetails: { ...bankDetails, accountNumber: "62012340000" },
    })).toEqual({ ok: false, reason: "evidence_changed" })
  })

  it("requires an exact signature hash and final document binding", () => {
    expect(verifyStoredSignedDebitMandate(signed(), expected)).toEqual(
      expect.objectContaining({
        ok: true,
        documentId: "mandate-1",
        documentSha256: "c".repeat(64),
      }),
    )
    expect(verifyStoredSignedDebitMandate({
      ...signed(),
      debitMandateSignatureData: "Changed signature",
    }, expected)).toEqual({ ok: false, reason: "signature_invalid" })
    expect(verifyStoredSignedDebitMandate({
      ...signed(),
      debitMandateDocumentSha256: null,
    }, expected)).toEqual({ ok: false, reason: "signed_document_missing" })
  })

  it("refuses a signature that predates the consumer agreement", () => {
    expect(verifyStoredSignedDebitMandate({
      ...signed(),
      debitMandateSignedAt: new Date("2026-07-23T11:00:00.000Z"),
    }, expected)).toEqual({ ok: false, reason: "signed_before_agreement" })
  })
})

/**
 * The debit authority must instruct what the consumer acknowledged, not what
 * the lender recalculated. With credit life accepted, the PASQ billing schedule
 * carries the premium and the affordability calculator schedule does not — so
 * these two sources DISAGREE by construction here. That divergence is the point
 * of the fixture: an implementation that reads the calculator instead of the
 * PASQ produces premium-free debit amounts and fails these assertions.
 */
describe("debitMandateContractTerms", () => {
  function contractWithAcceptedCreditLife(principal?: number) {
    const contractEvidence = createDebitMandateTestEvidence(
      principal === undefined ? {} : { principal },
    )
    const disclosure = {
      version: "credit-life-election-v1" as const,
      election: "ACCEPTED" as const,
      principalCents: contractEvidence.calculation.principal,
      termDays: 90,
      monthlyPremiumCents: 2_250,
      productId: "credit-life-1",
      productName: "Synthetic Credit Life",
      insurerId: "insurer-1",
      insurerName: "Synthetic Insurer",
    }
    const pasq = createPasqEvidence({
      tenantId: "tenant-1",
      applicationId: "application-1",
      clientId: "client-1",
      productId: "debit-mandate-test-product",
      termDays: 90,
      generatedAt: contractEvidence.startDate,
      calculator: contractEvidence.affordabilityResult.approval.calculator,
      creditLife: {
        election: disclosure.election,
        productId: disclosure.productId,
        productName: disclosure.productName,
        insurerId: disclosure.insurerId,
        insurerName: disclosure.insurerName,
        monthlyPremiumCents: disclosure.monthlyPremiumCents,
        disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION,
        disclosureSha256: createCreditLifeDisclosureSha256(disclosure),
      },
    })
    return { contractEvidence, pasq }
  }

  it("debits the premium-inclusive acknowledged PASQ amounts, not the calculator's", () => {
    const { contractEvidence, pasq } = contractWithAcceptedCreditLife()

    const contract = debitMandateContractTerms(
      contractEvidence.affordabilityResult,
      pasq,
    )

    expect(contract.contractFingerprint).toBe(
      contractEvidence.affordabilityResult.contract.fingerprint,
    )
    expect(contract.evidence.firstDebitAmountCents).toBe(
      pasq.billing.schedule[0].totalDueCents,
    )
    expect(contract.evidence.recurringDebitAmountCents).toBe(
      pasq.billing.schedule[1].totalDueCents,
    )
    // Guards the assertions above: if the two sources ever stopped diverging,
    // reading the wrong one would still pass and the test would be vacuous.
    const calculatorSchedule =
      contractEvidence.affordabilityResult.approval.calculator.schedule
    expect(pasq.billing.schedule[0].totalDueCents).not.toBe(
      calculatorSchedule[0].totalDueCents,
    )
  })

  it("refuses to build a mandate with no acknowledged PASQ at all", () => {
    const { contractEvidence } = contractWithAcceptedCreditLife()
    expect(() => debitMandateContractTerms(
      contractEvidence.affordabilityResult,
      null,
    )).toThrow(/Immutable signed repayment evidence/)
  })

  it("refuses a PASQ acknowledged against a different contract", () => {
    const { contractEvidence } = contractWithAcceptedCreditLife()
    // A PASQ for a DIFFERENT principal, generated properly so it is internally
    // intact. Hand-editing a fingerprint instead would only break the PASQ's
    // own integrity hash and get caught a step earlier, which would leave the
    // contract cross-check itself untested.
    const { pasq: foreignPasq } = contractWithAcceptedCreditLife(700_000)
    expect(foreignPasq.calculator.contractFingerprint).not.toBe(
      contractEvidence.affordabilityResult.contract.calculator.contractFingerprint,
    )

    expect(() => debitMandateContractTerms(
      contractEvidence.affordabilityResult,
      foreignPasq,
    )).toThrow(/Immutable signed repayment evidence/)
  })
})

describe("verified bank-statement evidence", () => {
  const statement = {
    id: "statement-1",
    contentSha256: "a".repeat(64),
    verifiedAt: new Date("2026-07-23T10:00:00.000Z"),
    extractionResult: {
      bankName: { value: "First National Bank", confidence: 0.99 },
      branchCode: { value: "250 655", confidence: 0.99 },
      accountNumber: { value: "620 1234 5678", confidence: 0.99 },
      accountType: { value: "Current account", confidence: 0.99 },
    },
    validationMismatch: false,
  }

  it("binds a verified, hashed statement whose extracted banking profile matches", () => {
    expect(verifiedBankStatementEvidence(statement, bankDetails)).toEqual({
      ok: true,
      evidence: expected.bankStatement,
    })
  })

  // A Discovery Bank statement for an approved application, signed by both
  // parties, must not be refused at payout. Discovery prints NO branch code anywhere
  // on the page — SA retail banks run one universal code — so the extraction
  // had no branchCode at all and the gate compared '' against the record.
  const discoveryStatement = {
    id: "statement-1",
    contentSha256: "a".repeat(64),
    verifiedAt: new Date("2026-07-23T10:00:00.000Z"),
    extractionResult: {
      bankName: { value: "Discovery Bank", confidence: 0.95 },
      accountHolder: { value: "MS Testperson", confidence: 0.95 },
      accountNumber: { value: "10000020011", confidence: 0.95 },
      accountType: { value: "Transaction Account", confidence: 0.95 },
      statementDate: { value: "2026-07-30", confidence: 0.95 },
    },
    validationMismatch: false,
  }
  const discoveryBankDetails = {
    bankName: "Discovery Bank",
    branchCode: "679000",
    accountNumber: "10000020011",
    accountType: "CHEQUE" as const,
  }

  it("binds a statement that prints no branch code at all", () => {
    expect(verifiedBankStatementEvidence(
      discoveryStatement,
      discoveryBankDetails,
    )).toEqual({ ok: true, evidence: expected.bankStatement })
  })

  it("binds a branch code that DISAGREES with the record", () => {
    // Asserted deliberately, not tolerated by accident. The branch code is
    // functionally determined by the bank, so checking bank AND branch checks
    // the bank twice, and banks still honour the legacy per-branch codes some
    // client records hold. Re-adding this leg — in either direction, extracted
    // or derived — would block honest clients for no fraud benefit. If this
    // test starts failing, the leg came back; that is the bug, not this.
    expect(verifiedBankStatementEvidence(
      {
        ...discoveryStatement,
        extractionResult: {
          ...discoveryStatement.extractionResult,
          branchCode: { value: "000000", confidence: 0.95 },
        },
      },
      discoveryBankDetails,
    )).toEqual({ ok: true, evidence: expected.bankStatement })
  })

  it("binds Discovery's 'Transaction Account' to a CHEQUE record", () => {
    // The singular form. The allow-list already knew 'transactional' and
    // 'transactionalaccount' and matches EXACTLY, so this fell through to null.
    expect(verifiedBankStatementEvidence(
      discoveryStatement,
      discoveryBankDetails,
    )).toEqual({ ok: true, evidence: expected.bankStatement })
  })

  it("binds an unrecognised product name when the record says OTHER", () => {
    expect(verifiedBankStatementEvidence(
      {
        ...discoveryStatement,
        extractionResult: {
          ...discoveryStatement.extractionResult,
          accountType: { value: "Vitality Money Flexi Thing", confidence: 0.4 },
        },
      },
      { ...discoveryBankDetails, accountType: "OTHER" as const },
    )).toEqual({ ok: true, evidence: expected.bankStatement })
  })

  it("binds an OTHER record against a statement printing no account type", () => {
    const { accountType: _dropped, ...withoutType } = discoveryStatement.extractionResult
    expect(verifiedBankStatementEvidence(
      { ...discoveryStatement, extractionResult: withoutType },
      { ...discoveryBankDetails, accountType: "OTHER" as const },
    )).toEqual({ ok: true, evidence: expected.bankStatement })
  })

  // A Capitec statement for an approved application, consumer and provider
  // signatures recorded, must not be refused at payout with
  // `verified_bank_statement_mismatch`. The page is headed "Main Account Statement" and names no product
  // anywhere — Capitec prints none — so the extractor answered OTHER, which
  // lib/vlm-extract.ts defines as "cannot tell", and the gate compared that
  // non-answer against a SAVINGS record.
  const capitecStatement = {
    id: "statement-1",
    contentSha256: "a".repeat(64),
    verifiedAt: new Date("2026-08-01T10:00:00.000Z"),
    extractionResult: {
      bankName: { value: "Capitec", validated: true },
      accountHolder: { value: "MR SIPHO TEST TESTPERSON", validated: true },
      accountNumber: { value: "1000000583", validated: true },
      accountType: { value: "OTHER", validated: true },
      statementDate: { value: "2026-08-01", validated: true },
    },
    validationMismatch: false,
  }
  const capitecEvidence = {
    ...expected.bankStatement,
    verifiedAt: capitecStatement.verifiedAt.toISOString(),
  }
  const capitecBankDetails = {
    bankName: "Capitec",
    branchCode: "470010",
    accountNumber: "1000000583",
    accountType: "SAVINGS" as const,
  }

  it("binds a statement whose extractor could not determine the account type", () => {
    expect(verifiedBankStatementEvidence(
      capitecStatement,
      capitecBankDetails,
    )).toEqual({ ok: true, evidence: capitecEvidence })
  })

  it("binds a statement printing no account type against a SAVINGS record", () => {
    const { accountType: _dropped, ...withoutType } = capitecStatement.extractionResult
    expect(verifiedBankStatementEvidence(
      { ...capitecStatement, extractionResult: withoutType },
      capitecBankDetails,
    )).toEqual({ ok: true, evidence: capitecEvidence })
  })

  it("still refuses a CONTRADICTING account type on a Capitec statement", () => {
    // Silence is waived; disagreement is not. A statement that names a type
    // the record does not hold is still a mismatch, and this is the assertion
    // that keeps the relaxation to silence alone.
    expect(verifiedBankStatementEvidence(
      {
        ...capitecStatement,
        extractionResult: {
          ...capitecStatement.extractionResult,
          accountType: { value: "Cheque", validated: true },
        },
      },
      capitecBankDetails,
    )).toEqual({
      ok: false,
      reason: "verified_bank_statement_mismatch",
      mismatchField: "accountType",
    })
  })

  it("treats a non-ASCII account type as silence, the same as Postgres does", () => {
    // Parity pin, not a realistic statement. "\u0130" is the codepoint the two
    // engines disagree on: lowercase-then-strip leaves "i" in JavaScript and
    // nothing in Postgres, so a hand-rolled compaction with the steps in that
    // order classifies this as EVIDENCE here and as SILENCE there — the route
    // refuses a payout the trigger would have allowed, or the reverse for other
    // codepoints. Both sides strip to ASCII first; this asserts it stays that
    // way. Verified against PostgreSQL 16: the guard ALLOWS this statement.
    expect(verifiedBankStatementEvidence(
      {
        ...capitecStatement,
        extractionResult: {
          ...capitecStatement.extractionResult,
          accountType: { value: "\u0130", validated: true },
        },
      },
      capitecBankDetails,
    )).toEqual({ ok: true, evidence: capitecEvidence })
  })

  it("still refuses a wrong ACCOUNT NUMBER when the type is undetermined", () => {
    // The account number is the whole control once the type leg is silent.
    expect(verifiedBankStatementEvidence(
      capitecStatement,
      { ...capitecBankDetails, accountNumber: "1000000584" },
    )).toEqual({
      ok: false,
      reason: "verified_bank_statement_mismatch",
      mismatchField: "accountNumber",
    })
  })

  // The container gap the DISBURSED guard does not have. Postgres COALESCEs
  // `fields.k.value`, `fields.k`, `k.value`, `k` — it falls through to the top
  // level when a `fields` object exists but lacks the key. This function bound
  // to one container, so the same statement read as SAVINGS in the DB and as
  // nothing here: the route admits the payout on silence and the trigger then
  // raises 23514 mid-transaction.
  describe("reads the same containers as the DB guard's COALESCE", () => {
    const mixedShape = {
      id: "statement-1",
      contentSha256: "a".repeat(64),
      verifiedAt: new Date("2026-08-01T10:00:00.000Z"),
      extractionResult: {
        fields: { bankName: { value: "Capitec" } },
        accountNumber: { value: "1000000583" },
        accountType: { value: "Cheque" },
      },
      validationMismatch: false,
    }

    it("sees a top-level key when a fields object exists without it", () => {
      // Every leg here lives at the top level next to a `fields` wrapper. The
      // account type CONTRADICTS the record, so a reader that cannot see it
      // returns ok — which is the bug, not the fix.
      expect(verifiedBankStatementEvidence(mixedShape, capitecBankDetails)).toEqual({
        ok: false,
        reason: "verified_bank_statement_mismatch",
        mismatchField: "accountType",
      })
    })

    it("still prefers the value inside fields when both containers have it", () => {
      // A priority pin, NOT a regression test for the fallback: `fields` holds
      // every key here, so the fallback is never reached and this passes with
      // it deleted. It is here to stop a future reader "simplifying" the two
      // lookups into one that consults the top level first, which would invert
      // the COALESCE order. The test above it is the fallback's regression
      // test.
      expect(verifiedBankStatementEvidence(
        {
          ...mixedShape,
          extractionResult: {
            fields: {
              bankName: { value: "Capitec" },
              accountNumber: { value: "1000000583" },
              accountType: { value: "savings" },
            },
            accountType: { value: "Cheque" },
          },
        },
        capitecBankDetails,
      )).toEqual({ ok: true, evidence: capitecEvidence })
    })

    it("reads a boolean inside fields rather than falling through", () => {
      // `->>` renders a JSON boolean as text, so Postgres takes the `fields`
      // arm and stops. A reader that skipped booleans would fall through to the
      // top-level key and compare a value the DB never looked at. Both engines
      // then refuse "true" as an account type — the point is that they refuse
      // for the SAME reason, having read the SAME field.
      expect(verifiedBankStatementEvidence(
        {
          ...mixedShape,
          extractionResult: {
            fields: {
              bankName: { value: "Capitec" },
              accountNumber: { value: "1000000583" },
              accountType: true,
            },
            accountType: { value: "savings" },
          },
        },
        capitecBankDetails,
      )).toEqual({
        ok: false,
        reason: "verified_bank_statement_mismatch",
        mismatchField: "accountType",
      })
    })

    it("still reads a flat extraction with no fields wrapper", () => {
      expect(verifiedBankStatementEvidence(
        capitecStatement,
        capitecBankDetails,
      )).toEqual({ ok: true, evidence: capitecEvidence })
    })
  })

  it("still refuses a wrong ACCOUNT NUMBER when the record says OTHER", () => {
    // OTHER relaxes exactly one leg. If it ever relaxes this one it has stopped
    // being an account-type escape hatch and become a way to pay the wrong
    // person — the account number is the control that stops that, not the
    // account type.
    expect(verifiedBankStatementEvidence(
      discoveryStatement,
      {
        ...discoveryBankDetails,
        accountType: "OTHER" as const,
        accountNumber: "10000020012",
      },
    )).toEqual({
      ok: false,
      reason: "verified_bank_statement_mismatch",
      mismatchField: "accountNumber",
    })
  })

  it("still refuses a wrong BANK when the record says OTHER", () => {
    expect(verifiedBankStatementEvidence(
      discoveryStatement,
      {
        ...discoveryBankDetails,
        accountType: "OTHER" as const,
        bankName: "Capitec",
      },
    )).toEqual({
      ok: false,
      reason: "verified_bank_statement_mismatch",
      mismatchField: "bankName",
    })
  })

  it("still refuses an unverified statement when the record says OTHER", () => {
    expect(verifiedBankStatementEvidence(
      { ...discoveryStatement, verifiedAt: null },
      { ...discoveryBankDetails, accountType: "OTHER" as const },
    )).toEqual({ ok: false, reason: "verified_bank_statement_missing" })
  })

  it("still refuses an unlisted product name when the record says CHEQUE", () => {
    // OTHER is an explicit staff decision, not a default. An unrecognised
    // product against a CHEQUE record must still fail closed, or the escape
    // hatch would be unnecessary and the control would be gone.
    expect(verifiedBankStatementEvidence(
      {
        ...discoveryStatement,
        extractionResult: {
          ...discoveryStatement.extractionResult,
          accountType: { value: "Vitality Money Flexi Thing", confidence: 0.4 },
        },
      },
      discoveryBankDetails,
    )).toEqual({
      ok: false,
      reason: "verified_bank_statement_mismatch",
      mismatchField: "accountType",
    })
  })

  it("refuses a transmission statement — it can no longer match any account", () => {
    // TRANSMISSION was retired as a selectable account type, so
    // no client record can be transmission and such a statement is always a
    // genuine mismatch. This ALSO keeps this canonicaliser in step with the
    // DATABASE one (`canonicalAccountType`), which never had a
    // transmission branch and returns '' — the two disagreeing meant the TS
    // layer accepted a mandate the DB guard would later reject at payout with
    // a bare 500.
    const transmissionStatement = {
      ...statement,
      extractionResult: {
        ...statement.extractionResult,
        accountType: { value: "Transmission account", confidence: 0.99 },
      },
    }
    for (const onFile of ["CHEQUE", "SAVINGS"] as const) {
      const result = verifiedBankStatementEvidence(
        transmissionStatement,
        { ...bankDetails, accountType: onFile },
      )
      expect(result.ok).toBe(false)
    }
  })

  it("binds a cheque/current statement label to a cheque account", () => {
    const chequeCurrentStatement = {
      ...statement,
      extractionResult: {
        ...statement.extractionResult,
        accountType: { value: "Cheque / Current", confidence: 0.99 },
      },
    }
    const result = verifiedBankStatementEvidence(
      chequeCurrentStatement,
      bankDetails,
    )
    expect(result.ok).toBe(true)
  })

  // SA banks print the PRODUCT name where the gate expects an account TYPE.
  // "EASY ACCOUNT" and "PRESTIGEACC" are both FNB transactional accounts, but
  // if neither canonicalised the payout tuple could never match and approved
  // disbursements would be refused with `verified_bank_statement_mismatch` —
  // despite a correct account number, bank and branch code.
  it.each([
    ["EASY ACCOUNT"],
    ["Easy Account"],
    ["PRESTIGEACC"],
  ])("binds the FNB transactional product name %s to a cheque account", (label) => {
    const productStatement = {
      ...statement,
      extractionResult: {
        ...statement.extractionResult,
        accountType: { value: label, confidence: 0.99 },
      },
    }
    expect(verifiedBankStatementEvidence(productStatement, bankDetails)).toEqual({
      ok: true,
      evidence: expected.bankStatement,
    })
  })

  // A product prefix must name one product, not a brand. "prestige" alone would
  // also match "Prestige Savings", binding a savings statement to a cheque
  // payout record — the account-type leg of the payout tuple would stop
  // discriminating for that whole product family.
  //
  // The mid-string cases are the mutation guard: under `startsWith` they are
  // refused, under `includes` they would bind, so a silent widening of the
  // match is caught here rather than at a payout.
  it.each([
    ["Prestige Savings Account"],
    ["Prestige Savings"],
    ["SUPER EASY ACCOUNT"],
    ["FNB PRESTIGEACC"],
    ["Cheque Current XYZ Account"],
  ])("refuses %s, which no product prefix may reach", (label) => {
    const productStatement = {
      ...statement,
      extractionResult: {
        ...statement.extractionResult,
        accountType: { value: label, confidence: 0.99 },
      },
    }
    for (const onFile of ["CHEQUE", "SAVINGS"] as const) {
      expect(verifiedBankStatementEvidence(
        productStatement,
        { ...bankDetails, accountType: onFile },
      )).toMatchObject({ ok: false, reason: "verified_bank_statement_mismatch" })
    }
  })

  // The product names resolve to CHEQUE specifically — not to "whatever is on
  // file". Without this, mapping them to a wildcard would silently pass a
  // savings record against a transactional statement.
  it.each([
    ["EASY ACCOUNT"],
    ["PRESTIGEACC"],
  ])("still refuses %s against a savings account on file", (label) => {
    const productStatement = {
      ...statement,
      extractionResult: {
        ...statement.extractionResult,
        accountType: { value: label, confidence: 0.99 },
      },
    }
    expect(verifiedBankStatementEvidence(
      productStatement,
      { ...bankDetails, accountType: "SAVINGS" },
    )).toMatchObject({ ok: false, reason: "verified_bank_statement_mismatch" })
  })

  it("still flags a transmission statement against a cheque account", () => {
    const transmissionStatement = {
      ...statement,
      extractionResult: {
        ...statement.extractionResult,
        accountType: { value: "Transmission account", confidence: 0.99 },
      },
    }
    expect(verifiedBankStatementEvidence(transmissionStatement, bankDetails))
      .toMatchObject({ ok: false, reason: "verified_bank_statement_mismatch" })
  })

  it.each([
    // The fourth element is the failing leg, and is undefined for the failures
    // that never reach the tuple comparison at all.
    ["missing verification", { ...statement, verifiedAt: null }, "verified_bank_statement_missing", undefined],
    ["missing hash", { ...statement, contentSha256: null }, "verified_bank_statement_integrity_missing", undefined],
    ["recorded mismatch", { ...statement, validationMismatch: true }, "verified_bank_statement_missing", undefined],
    [
      "different account",
      {
        ...statement,
        extractionResult: {
          ...statement.extractionResult,
          accountNumber: { value: "62000000000" },
        },
      },
      "verified_bank_statement_mismatch",
      "accountNumber",
    ],
    [
      "different bank",
      {
        ...statement,
        extractionResult: {
          ...statement.extractionResult,
          bankName: { value: "Nedbank" },
        },
      },
      "verified_bank_statement_mismatch",
      "bankName",
    ],
    // "different branch" is not a case here. It is asserted
    // to BIND, in "binds a branch code that DISAGREES with the record" above —
    // the branch code is functionally determined by the bank, so this leg
    // checked the bank twice while blocking clients whose statement prints no
    // branch code at all. Moved rather than deleted so the rule is visible.
    [
      "different account type",
      {
        ...statement,
        extractionResult: {
          ...statement.extractionResult,
          accountType: { value: "Savings" },
        },
      },
      "verified_bank_statement_mismatch",
      "accountType",
    ],
    [
      "incomplete extracted banking profile",
      {
        ...statement,
        extractionResult: {
          accountNumber: statement.extractionResult.accountNumber,
        },
      },
      "verified_bank_statement_mismatch",
      // An account number but no bank name is a partial read, not an empty one:
      // `extraction_empty` is reserved for a page nothing came off, which is
      // what a password-locked PDF produces and what has a different remedy.
      "bankName",
    ],
    [
      "an extraction that read only an account type",
      {
        ...statement,
        extractionResult: {
          accountType: statement.extractionResult.accountType,
        },
      },
      "verified_bank_statement_mismatch",
      // Read, just not enough of it. Calling this `extraction_empty` would send
      // staff to re-upload an unlocked copy of a page that was machine-read.
      "accountNumber",
    ],
    [
      "an extraction with nothing in it at all",
      {
        ...statement,
        extractionResult: {},
      },
      "verified_bank_statement_mismatch",
      "extraction_empty",
    ],
  ])("rejects %s", (_label, document, reason, mismatchField) => {
    expect(verifiedBankStatementEvidence(document, bankDetails)).toEqual({
      ok: false,
      reason,
      mismatchField,
    })
  })
})

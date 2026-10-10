import { canonicalJson } from "@/lib/canonical-json"
import { canonicalBankName } from "@/lib/banks"
import { createHash } from "node:crypto"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import {
  acceptedPasqCalculatorFingerprint,
  affordabilityContractEvidenceIsIntact,
  loanCalculationFromEvidence,
  readAffordabilitySnapshotStore,
} from "@/lib/affordability/snapshot"
import {
  pasqEvidenceIsIntact,
  type PasqEvidence,
} from "@/lib/compliance/pasq"
import { debitMandatePaymentTerms } from "@/lib/loan/debit-mandate"

export const DEBIT_MANDATE_EVIDENCE_VERSION = "debit-mandate-v1" as const

/**
 * The account types a PAYOUT may be made to.
 *
 * Strictly wider than `DebitOrderAccountType`. OTHER is payout-only: an EFT
 * needs a bank, a branch code and an account number, and does not care what the
 * bank calls the product. A debit order does — `netcash-avs-wire.ts` has to put
 * "Current" or "Savings" on the wire and has no third value to send.
 */
export type PayoutAccountType = "CHEQUE" | "SAVINGS" | "OTHER"

export type DebitOrderAccountType = "CHEQUE" | "SAVINGS"

export type PayoutBankDetails = {
  bankName: string
  branchCode: string
  accountNumber: string
  accountType: PayoutAccountType
}

/**
 * The same tuple with the narrower account type a debit order can carry.
 *
 * Assignable to PayoutBankDetails, so every debit-order caller of the shared
 * payout gate keeps working while the compiler refuses an OTHER account
 * anywhere a mandate is prepared or an AVS check is wired.
 */
export type DebitMandateBankDetails = Omit<PayoutBankDetails, "accountType"> & {
  accountType: DebitOrderAccountType
}

export type DebitMandateTermsEvidence = {
  paymentFrequency: "ONCE_OFF" | "MONTHLY"
  recurringDebitAmountCents: number | null
  firstDebitAmountCents: number
  firstDebitDate: string
  firstDebitInitiationFeeCents: number
}

export type DebitMandateContractTerms = {
  contractFingerprint: string
  paymentTerms: {
    paymentFrequency: "ONCE_OFF" | "MONTHLY"
    recurringDebitAmount: number | null
    firstDebitAmount: number
    firstDebitDate: Date
    firstDebitInitiationFee: number
  }
  evidence: DebitMandateTermsEvidence
}

/**
 * The debit authority must instruct the exact amounts the consumer signed for.
 * The affordability contract alone cannot prove that: it is the lender's own
 * calculation, whereas the PASQ billing schedule is the acknowledged quotation.
 * Deriving the debit amounts from the calculator while only *hashing* the PASQ
 * lets the two drift and still produce a mandate, so bind them here — the
 * amounts come from the PASQ, the due dates from the immutable contract, and a
 * disagreement between them is a hard failure rather than a silent preference.
 */
export function debitMandateContractTerms(
  affordabilityResult: unknown,
  pasqEvidenceValue: unknown,
): DebitMandateContractTerms {
  const store = readAffordabilitySnapshotStore(affordabilityResult)
  if (
    !store.approval
    || !store.contract
    || !affordabilityContractEvidenceIsIntact(store.contract, store.approval)
    || !pasqEvidenceIsIntact(pasqEvidenceValue)
  ) {
    throw new Error("Immutable signed repayment evidence is missing or invalid.")
  }
  const pasqEvidence: PasqEvidence = pasqEvidenceValue
  const calculation = loanCalculationFromEvidence(store.contract.calculator)
  if (
    pasqEvidence.calculator.contractFingerprint
      !== acceptedPasqCalculatorFingerprint(store.contract)
    || pasqEvidence.billing.schedule.length
      !== store.contract.calculator.schedule.length
  ) {
    throw new Error("Immutable signed repayment evidence is missing or invalid.")
  }
  const schedule = pasqEvidence.billing.schedule.map((item, index) => {
    const contractItem = store.contract!.calculator.schedule[index]
    if (
      !contractItem
      || contractItem.installmentNo !== item.installmentNo
    ) {
      throw new Error("Immutable signed repayment evidence is missing or invalid.")
    }
    return {
      installmentNo: item.installmentNo,
      dueDate: new Date(contractItem.dueDate),
      principalDue: item.principalDueCents,
      interestDue: item.interestDueCents,
      feesDue: item.feesDueCents,
      totalDue: item.totalDueCents,
    }
  })
  const maturityDate = schedule.at(-1)?.dueDate
  if (!maturityDate) {
    throw new Error("A complete repayment schedule is required before generating a debit mandate.")
  }
  const paymentTerms = debitMandatePaymentTerms({
    schedule,
    principal: calculation.principal,
    totalInterest: calculation.totalInterest,
    totalRepayable: pasqEvidence.billing.totalRepayableCents,
    initiationFee: calculation.initiationFee,
    initiationFeePayment: store.approval.inputs.initiationFeePayment,
    startDate: new Date(store.contract.establishedAt),
    maturityDate,
    affordabilityResult,
    pasqEvidence,
  })
  return {
    contractFingerprint: store.contract.fingerprint,
    paymentTerms,
    evidence: {
      paymentFrequency: paymentTerms.paymentFrequency,
      recurringDebitAmountCents: paymentTerms.recurringDebitAmount,
      firstDebitAmountCents: paymentTerms.firstDebitAmount,
      firstDebitDate: paymentTerms.firstDebitDate.toISOString(),
      firstDebitInitiationFeeCents: paymentTerms.firstDebitInitiationFee,
    },
  }
}

export type DebitMandateBankStatementEvidence = {
  documentId: string
  documentSha256: string
  verifiedAt: string
}

export type DebitMandateEvidence = {
  version: typeof DEBIT_MANDATE_EVIDENCE_VERSION
  applicationId: string
  clientId: string
  collectionReference: string
  contractFingerprint: string
  bankDetailsSha256: string
  bankAccountMasked: string
  bankStatement: DebitMandateBankStatementEvidence
  terms: DebitMandateTermsEvidence
  preparedAt: string
}

export type StoredDebitMandatePreparation = {
  debitMandatePreparedAt: Date | null
  debitMandateReference: string | null
  debitMandateDraftSha256: string | null
  debitMandateEvidence: unknown
  debitMandateEvidenceSha256: string | null
}

export type StoredSignedDebitMandate = StoredDebitMandatePreparation & {
  agreementSignedAt: Date | null
  debitMandateSignedAt: Date | null
  debitMandateSignedMethod: string | null
  debitMandateSignatureData: string | null
  debitMandateSignatureSha256: string | null
  debitMandateDocumentId: string | null
  debitMandateDocumentSha256: string | null
}

export type DebitMandateExpectedEvidence = {
  applicationId: string
  clientId: string
  contractFingerprint: string
  bankDetails: DebitMandateBankDetails
  bankStatement: DebitMandateBankStatementEvidence
  terms: DebitMandateTermsEvidence
}

export type DebitMandatePreparationFailure =
  | "preparation_missing"
  | "preparation_incomplete"
  | "evidence_invalid"
  | "evidence_changed"
  | "draft_hash_invalid"

export type SignedDebitMandateFailure =
  | DebitMandatePreparationFailure
  | "signature_missing"
  | "signature_invalid"
  | "signed_document_missing"
  | "signed_before_agreement"

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function normalizedBankDetails(bank: DebitMandateBankDetails) {
  return {
    bankName: cleanText(bank.bankName).toLocaleLowerCase("en-ZA"),
    branchCode: bank.branchCode.replace(/\D/g, ""),
    accountNumber: bank.accountNumber.replace(/\D/g, ""),
    accountType: bank.accountType,
  }
}


export function sha256DebitMandateValue(value: unknown): string {
  const source = typeof value === "string" ? value : canonicalJson(value)
  return createHash("sha256").update(source, "utf8").digest("hex")
}

export function debitMandateBankDetailsSha256(
  bank: DebitMandateBankDetails,
): string {
  return sha256DebitMandateValue(normalizedBankDetails(bank))
}

export function maskDebitMandateAccountNumber(accountNumber: string): string {
  const normalized = accountNumber.replace(/\D/g, "")
  if (normalized.length <= 4) return normalized
  return `${"*".repeat(normalized.length - 4)}${normalized.slice(-4)}`
}

export function createDebitMandateEvidence(args: DebitMandateExpectedEvidence & {
  collectionReference: string
  preparedAt: Date
}): DebitMandateEvidence {
  return {
    version: DEBIT_MANDATE_EVIDENCE_VERSION,
    applicationId: args.applicationId,
    clientId: args.clientId,
    collectionReference: cleanText(args.collectionReference),
    contractFingerprint: args.contractFingerprint,
    bankDetailsSha256: debitMandateBankDetailsSha256(args.bankDetails),
    bankAccountMasked: maskDebitMandateAccountNumber(args.bankDetails.accountNumber),
    bankStatement: args.bankStatement,
    terms: args.terms,
    preparedAt: args.preparedAt.toISOString(),
  }
}

export function debitMandateEvidenceSha256(
  evidence: DebitMandateEvidence,
): string {
  return sha256DebitMandateValue(evidence)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function readDebitMandateEvidence(value: unknown): DebitMandateEvidence | null {
  if (!isRecord(value) || !isRecord(value.bankStatement) || !isRecord(value.terms)) {
    return null
  }
  const bankStatement = value.bankStatement
  const terms = value.terms
  if (
    value.version !== DEBIT_MANDATE_EVIDENCE_VERSION
    || typeof value.applicationId !== "string"
    || typeof value.clientId !== "string"
    || typeof value.collectionReference !== "string"
    || typeof value.contractFingerprint !== "string"
    || typeof value.bankDetailsSha256 !== "string"
    || typeof value.bankAccountMasked !== "string"
    || typeof value.preparedAt !== "string"
    || typeof bankStatement.documentId !== "string"
    || typeof bankStatement.documentSha256 !== "string"
    || typeof bankStatement.verifiedAt !== "string"
    || (terms.paymentFrequency !== "ONCE_OFF" && terms.paymentFrequency !== "MONTHLY")
    || (
      terms.recurringDebitAmountCents !== null
      && !Number.isInteger(terms.recurringDebitAmountCents)
    )
    || !Number.isInteger(terms.firstDebitAmountCents)
    || typeof terms.firstDebitDate !== "string"
    || !Number.isInteger(terms.firstDebitInitiationFeeCents)
  ) {
    return null
  }
  const evidence = value as unknown as DebitMandateEvidence
  if (
    !isSha256Digest(evidence.bankDetailsSha256)
    || !isSha256Digest(evidence.bankStatement.documentSha256)
    || !Number.isFinite(new Date(evidence.preparedAt).getTime())
    || !Number.isFinite(new Date(evidence.bankStatement.verifiedAt).getTime())
    || !Number.isFinite(new Date(evidence.terms.firstDebitDate).getTime())
    || evidence.terms.firstDebitAmountCents <= 0
    || evidence.terms.firstDebitInitiationFeeCents < 0
    || (
      evidence.terms.paymentFrequency === "MONTHLY"
      && (
        evidence.terms.recurringDebitAmountCents === null
        || evidence.terms.recurringDebitAmountCents <= 0
      )
    )
    || (
      evidence.terms.paymentFrequency === "ONCE_OFF"
      && evidence.terms.recurringDebitAmountCents !== null
    )
  ) {
    return null
  }
  return evidence
}

export function verifyStoredDebitMandatePreparation(
  stored: StoredDebitMandatePreparation,
  expected: DebitMandateExpectedEvidence,
):
  | {
      ok: true
      evidence: DebitMandateEvidence
      evidenceSha256: string
      draftDocumentSha256: string
    }
  | { ok: false; reason: DebitMandatePreparationFailure } {
  if (
    !stored.debitMandatePreparedAt
    && !stored.debitMandateReference
    && !stored.debitMandateDraftSha256
    && !stored.debitMandateEvidence
    && !stored.debitMandateEvidenceSha256
  ) {
    return { ok: false, reason: "preparation_missing" }
  }
  if (
    !stored.debitMandatePreparedAt
    || !stored.debitMandateReference
    || !stored.debitMandateDraftSha256
    || !stored.debitMandateEvidence
    || !stored.debitMandateEvidenceSha256
  ) {
    return { ok: false, reason: "preparation_incomplete" }
  }
  if (!isSha256Digest(stored.debitMandateDraftSha256)) {
    return { ok: false, reason: "draft_hash_invalid" }
  }
  const evidence = readDebitMandateEvidence(stored.debitMandateEvidence)
  if (!evidence || !isSha256Digest(stored.debitMandateEvidenceSha256)) {
    return { ok: false, reason: "evidence_invalid" }
  }
  const evidenceSha256 = debitMandateEvidenceSha256(evidence)
  if (evidenceSha256 !== stored.debitMandateEvidenceSha256) {
    return { ok: false, reason: "evidence_invalid" }
  }
  const expectedEvidence = createDebitMandateEvidence({
    ...expected,
    collectionReference: stored.debitMandateReference,
    preparedAt: stored.debitMandatePreparedAt,
  })
  if (
    canonicalJson(evidence) !== canonicalJson(expectedEvidence)
    || evidence.preparedAt !== stored.debitMandatePreparedAt.toISOString()
  ) {
    return { ok: false, reason: "evidence_changed" }
  }
  return {
    ok: true,
    evidence,
    evidenceSha256,
    draftDocumentSha256: stored.debitMandateDraftSha256,
  }
}

/**
 * The signature legs of a signed debit mandate, on their own.
 *
 * `verifyStoredSignedDebitMandate` below is the whole rule and needs the
 * expected evidence — the contract terms, the product, the verified bank
 * statement — to re-derive. A reader that only wants to know whether the
 * customer has signed ANYTHING (the board's readiness chip) cannot pay that,
 * and a hand-copied version of these three checks beside it was the first
 * thing to drift. This is a NECESSARY condition: false is authoritative,
 * true still leaves the evidence legs unchecked.
 */
export function debitMandateSignatureLegs(
  stored: StoredSignedDebitMandate,
):
  | {
      ok: true
      signedAt: Date
      signatureSha256: string
      documentId: string
      documentSha256: string
    }
  | { ok: false; reason: SignedDebitMandateFailure } {
  if (
    !stored.debitMandateSignedAt
    || !stored.debitMandateSignedMethod
    || !stored.debitMandateSignatureData
    || !stored.debitMandateSignatureSha256
  ) {
    return { ok: false, reason: "signature_missing" }
  }
  if (
    stored.debitMandateSignedMethod !== "portal"
    || !isSha256Digest(stored.debitMandateSignatureSha256)
    || sha256DebitMandateValue(stored.debitMandateSignatureData)
      !== stored.debitMandateSignatureSha256
  ) {
    return { ok: false, reason: "signature_invalid" }
  }
  if (
    !stored.debitMandateDocumentId
    || !isSha256Digest(stored.debitMandateDocumentSha256)
  ) {
    return { ok: false, reason: "signed_document_missing" }
  }
  // Returned narrowed, so the caller does not have to re-assert what these
  // checks just proved — the non-null assertions this replaced were exactly
  // the kind of restatement that outlives the check it depends on.
  return {
    ok: true,
    signedAt: stored.debitMandateSignedAt,
    signatureSha256: stored.debitMandateSignatureSha256,
    documentId: stored.debitMandateDocumentId,
    documentSha256: stored.debitMandateDocumentSha256!,
  }
}

export function verifyStoredSignedDebitMandate(
  stored: StoredSignedDebitMandate,
  expected: DebitMandateExpectedEvidence,
):
  | {
      ok: true
      evidence: DebitMandateEvidence
      evidenceSha256: string
      draftDocumentSha256: string
      signedAt: Date
      signatureSha256: string
      documentId: string
      documentSha256: string
    }
  | { ok: false; reason: SignedDebitMandateFailure } {
  const preparation = verifyStoredDebitMandatePreparation(stored, expected)
  if (!preparation.ok) return preparation
  const signature = debitMandateSignatureLegs(stored)
  if (!signature.ok) return signature
  if (
    !stored.agreementSignedAt
    || signature.signedAt < stored.agreementSignedAt
    || signature.signedAt < stored.debitMandatePreparedAt!
  ) {
    return { ok: false, reason: "signed_before_agreement" }
  }
  return {
    ...preparation,
    signedAt: signature.signedAt,
    signatureSha256: signature.signatureSha256,
    documentId: signature.documentId,
    documentSha256: signature.documentSha256,
  }
}

export type DebitMandateBankStatementDocument = {
  id: string
  contentSha256: string | null
  verifiedAt: Date | null
  extractionResult: unknown
  validationMismatch: boolean
}

// canonicalBankName now lives in lib/banks.ts (imported at the top of this
// file) so the pickers that WRITE bankName and the gate that READS it share one
// vocabulary. A second copy is how the account-type canonicaliser drifted from
// its Postgres twin; see the note in that file.

/**
 * Generic account-type labels, matched EXACTLY after compaction.
 *
 * These mirror the `compact IN (...)` lists in the DB canonicaliser
 * `canonicalAccountType` value for value. They used to be matched here
 * with `startsWith(`${label}account`)` while the DB matched exactly, so
 * "Cheque Current XYZ Account" canonicalised to CHEQUE in this process and to
 * '' in Postgres — the route accepted a payout the DISBURSED trigger then
 * rejected mid-transaction with 23514. Exact on both sides closes that.
 */
export const CHEQUE_ACCOUNT_LABELS = [
  "cheque",
  "check",
  "checking",
  "current",
  "transactional",
  // Discovery Bank prints exactly "Transaction Account" in its statement
  // header. The list already knew "transactional" and "transactionalaccount"
  // and matches EXACTLY, so the singular form fell through to null and refused
  // a payout that was correct in every other respect. Added against a real
  // statement.
  "transaction",
  "transactionaccount",
  "chequeaccount",
  "checkaccount",
  "checkingaccount",
  "currentaccount",
  "transactionalaccount",
  "chequecurrent",
  "chequecurrentaccount",
  "currentcheque",
  "currentchequeaccount",
] as const

export const SAVINGS_ACCOUNT_LABELS = [
  "saving",
  "savings",
  "savingaccount",
  "savingsaccount",
] as const

/**
 * Bank PRODUCT names that denote a transactional (cheque/current) account.
 *
 * A statement prints the product a client holds, not the account type the
 * payout tuple is recorded under — FNB prints "EASY ACCOUNT", never "Cheque
 * Account". Every name here canonicalises to CHEQUE, so an unlisted product
 * still fails closed as a mismatch rather than matching whatever is on file.
 *
 * These are the only PREFIX matches in this function, and each must stay long
 * enough to name one product rather than a brand: "prestigeacc" matches the
 * statement value PRESTIGEACC and "Prestige Account", but must never shorten to
 * "prestige", which would also swallow a hypothetical "Prestige Savings" and
 * bind a savings statement to a cheque payout record.
 *
 * Add a name only against a real statement. The newest migration that replaces
 * `canonicalAccountType` carries the same list for the DB guard, and
 * `debit-mandate-product-names.test.ts` fails if the two ever disagree.
 */
export const TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES = [
  "easyaccount",
  "prestigeacc",
] as const

/**
 * Reduce a value to lowercase ASCII letters, the one representation the
 * TypeScript and Postgres sides can both produce identically.
 *
 * STRIP FIRST, THEN LOWERCASE, and never inline a second copy of this with the
 * steps the other way round. Lowercasing first diverges on "\u0130", which
 * `toLocaleLowerCase` expands to "i" plus a combining dot: the ASCII strip then
 * leaves `i` here while Postgres, which strips before lowering, leaves nothing.
 * Every account-type decision on both sides of the payout gate goes through
 * this order — see the long note on `canonicalAccountType` below for why parity
 * by Unicode class matching is unreachable.
 */
function compactAsciiLetters(value: string): string {
  return value.replace(/[^a-zA-Z]/g, "").toLowerCase()
}

/**
 * Exported ONLY so the integration suite can compare it, input for input,
 * against the Postgres twin `canonicalAccountType`. The two must agree on
 * every string, not merely carry the same label lists — see the note on the
 * character class below.
 */
export function canonicalAccountType(
  value: string,
): "CHEQUE" | "SAVINGS" | null {
  // `[^a-z]` here, `[^[:alpha:]]` in Postgres — these are NOT the same class,
  // and the difference is a real divergence rather than a stylistic one.
  // Postgres keeps accented letters, so "Chequé" compacts to `chequé` there and
  // to `cheque` here: the route would canonicalise it to CHEQUE, accept the
  // payout, and the DISBURSED trigger would then raise 23514 mid-transaction
  // after both signatures were recorded. That is precisely the failure the
  // TS/SQL parity test exists to prevent, and the parity test cannot see it
  // because it compares the LABEL LISTS, not the normalisation around them.
  //
  // ASCII-ONLY, AND IN THIS ORDER, because it must be byte-identical to the
  // Postgres twin `canonicalAccountType`. Read the migration before
  // touching either.
  //
  // Two earlier attempts at parity were measured wrong. `[^a-z]` after
  // lowercasing DROPS accented letters while Postgres `[[:alpha:]]` KEEPS them,
  // so "Savingsé" compacted to `savings` here and stayed `savingsé` there: the
  // route accepts the payout and the DISBURSED trigger raises 23514
  // mid-transaction, after both signatures are recorded. Switching to `\p{L}`
  // looked exact and is not — Postgres `[[:alpha:]]` under a UTF-8 locale is
  // Unicode ALPHABETIC, not LETTER, and the two disagree on ~1100 codepoints,
  // most of them in the same dangerous direction (measured against PG16: TS
  // "cheque"+U+0345 -> `cheque` and matches, SQL -> `chequeͅ` and refuses).
  //
  // No JS class can match glibc's `alpha` exactly, so parity by class matching
  // is unreachable. Restricting BOTH sides to ASCII letters is reachable, and
  // is locale-independent: after the strip only [A-Za-z] survives, so the
  // lowercase step cannot differ between engines or locales either.
  //
  // STRIP FIRST, THEN LOWERCASE — the same order as the SQL. Lowercasing first
  // diverges on "İ" (U+0130), which `toLocaleLowerCase` expands to "i" plus a
  // combining dot; the ASCII strip then leaves `i` here while Postgres, which
  // strips before lowering, leaves nothing.
  const compact = compactAsciiLetters(value)
  if ((CHEQUE_ACCOUNT_LABELS as readonly string[]).includes(compact)) {
    return "CHEQUE"
  }
  if (TRANSACTIONAL_ACCOUNT_PRODUCT_PREFIXES.some(
    (product) => compact.startsWith(product),
  )) {
    return "CHEQUE"
  }
  if ((SAVINGS_ACCOUNT_LABELS as readonly string[]).includes(compact)) {
    return "SAVINGS"
  }
  // Transmission is deliberately NOT canonicalised. It is no longer a
  // selectable account type (see prisma/schema.prisma BankAccountType), so no
  // client record can be TRANSMISSION and a transmission statement can only
  // ever be a genuine mismatch. This also keeps this function in step with the
  // DATABASE canonicaliser `canonicalAccountType`, which has never had
  // a transmission branch and returns '' — the two disagreeing was a real
  // defect on the disbursement path.
  return null
}

/**
 * Every JSON scalar Postgres's `->>` turns into text, and nothing else.
 *
 * Booleans are in the list for parity, not because the extractor emits them.
 * `->>` renders `true` as the text "true", which is a non-null COALESCE arm and
 * ends the search — so a reader that skipped booleans would fall through to a
 * DIFFERENT container than the SQL just chose, which is the exact class of
 * divergence this file exists to close. A "true" that reaches a comparison
 * canonicalises to nothing on both sides and is refused by both.
 */
function isJsonScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
}

function scalarFieldValue(container: unknown, key: string): string | null {
  if (!isRecord(container)) return null
  const field = container[key]
  if (isJsonScalar(field)) return String(field)
  if (isRecord(field) && isJsonScalar(field.value)) return String(field.value)
  return null
}

/**
 * Read one extracted field, trying the SAME containers in the SAME order as the
 * DISBURSED guard's COALESCE: inside `fields` first, then the top level.
 *
 * The fallback is the point. This used to bind to ONE container — if a `fields`
 * object existed at all, the key was looked up only inside it and a top-level
 * sibling was invisible. Postgres has always fallen through to the top level,
 * so `{fields: {bankName: …}, accountType: {value: "SAVINGS"}}` read as SAVINGS
 * in the DB and as nothing here. That is the divergence this module keeps
 * paying for: the route sees no account type, treats it as silence and admits
 * the payout, and the trigger sees SAVINGS, disagrees with the record and
 * raises 23514 mid-transaction with both signatures already recorded.
 *
 * No known extraction carries that shape (those with a `fields` wrapper are
 * OTHER/PROOF_OF_PAYMENT and carry no payout key at either level), so this
 * closes a latent gap rather than changing any current decision.
 *
 * One narrower divergence is deliberately left: for a non-scalar `value` (e.g.
 * `{accountType: {value: {…}}}`) Postgres's `->>` stringifies the JSON and this
 * returns null. The extractor's schema cannot produce it — see the accountType
 * instruction in lib/vlm-extract.ts — so it is recorded, not coded around.
 */
function extractedFieldValue(
  extractionResult: unknown,
  key: string,
): string | null {
  if (!isRecord(extractionResult)) return null
  return scalarFieldValue(extractionResult.fields, key)
    ?? scalarFieldValue(extractionResult, key)
}

/**
 * Does the statement's printed account type satisfy what the client is on
 * record as holding?
 *
 * OTHER short-circuits this by design — see the note on `BankAccountType.OTHER`
 * in prisma/schema.prisma. It is the authorised, audited escape hatch for a
 * bank product name the allow-lists have not learned, and it exists so that a
 * novel product name costs a staff decision rather than a code change, a paired
 * migration and a deploy.
 *
 * The DB twin of this rule lives in `canonicalAccountType` and the
 * DISBURSED guards. They must agree: a value accepted here and refused there is
 * how a payout gets accepted by the route and then rejected mid-transaction
 * with 23514, after both signatures are already recorded.
 */
/**
 * The extractor's own "cannot tell" answer, not a value read off a statement.
 * `lib/vlm-extract.ts` instructs the model to return exactly CHEQUE, SAVINGS or
 * OTHER for a bank statement, and to answer OTHER "when the product is
 * genuinely neither or you cannot tell -- do NOT guess". OTHER arriving here is
 * therefore the ABSENCE of evidence about the account type, and must be treated
 * as such rather than as a statement that contradicts the record.
 */
export const UNDETERMINED_EXTRACTED_ACCOUNT_TYPE = "other"

function extractedAccountTypeIsEvidence(
  extracted: string | null,
): extracted is string {
  if (!extracted) return false
  const compact = compactAsciiLetters(extracted)
  return compact !== "" && compact !== UNDETERMINED_EXTRACTED_ACCOUNT_TYPE
}

function recordedAccountTypeIsSatisfied(
  extracted: string | null,
  bankDetails: PayoutBankDetails,
): boolean {
  if (bankDetails.accountType === "OTHER") return true
  // A statement that names no account type cannot disagree with one.
  //
  // A statement page headed only "Main Account Statement" names no product
  // anywhere, so the extractor correctly answers OTHER. Treating that
  // non-answer as a mismatch against a SAVINGS record would refuse payout on
  // an approved application with both signatures recorded, and make every
  // statement carrying no determinable account type undisbursable.
  //
  // Passing costs no control. The account NUMBER is what binds the payout to
  // this account, and it still has to match exactly, as do the bank name and
  // the statement's integrity hash. One account number is one account and an
  // account has one type, so an account-type leg can only ever re-refuse what
  // the account-number leg already refused -- or, as here, refuse an honest
  // client whose bank does not print the field.
  if (!extractedAccountTypeIsEvidence(extracted)) return true
  // An unrecognised PRODUCT name is a different thing and still fails closed:
  // that is evidence we could not interpret, not evidence that is absent. The
  // staff escape hatch for it remains BankAccountType.OTHER on the record.
  return canonicalAccountType(extracted) === bankDetails.accountType
}

/**
 * The first leg of the payout tuple the statement fails, in the order the gate
 * checks them. Returns null when the statement binds.
 */
function payoutTupleMismatchField(
  extracted: {
    extractedAccount: string | undefined
    extractedBank: string | null
    extractedAccountType: string | null
  },
  bankDetails: PayoutBankDetails,
):
  | "extraction_empty"
  | "accountNumber"
  | "bankName"
  | "accountType"
  | null {
  // Nothing was read off the page at all. Reported separately because it is the
  // one cause whose remedy is not "correct the record": a password-protected
  // PDF is never machine-read, so no field disagrees — every field is absent.
  // EVERY field, deliberately: a page that yielded an account type but no
  // account number was read, and sending staff to re-upload an unlocked copy
  // of a readable statement is the same dead end this value exists to end.
  if (
    !extracted.extractedAccount
    && !extracted.extractedBank
    && !extracted.extractedAccountType
  ) {
    return "extraction_empty"
  }
  if (
    !extracted.extractedAccount
    || extracted.extractedAccount !== bankDetails.accountNumber.replace(/\D/g, "")
  ) {
    return "accountNumber"
  }
  if (
    !extracted.extractedBank
    || canonicalBankName(extracted.extractedBank)
      !== canonicalBankName(bankDetails.bankName)
  ) {
    return "bankName"
  }
  if (!recordedAccountTypeIsSatisfied(extracted.extractedAccountType, bankDetails)) {
    return "accountType"
  }
  return null
}

/**
 * Bind a payout tuple to an intact, verified bank statement.
 *
 * THE BRANCH CODE IS DELIBERATELY NOT CHECKED HERE. It used to be, against the
 * value the VLM read off the statement, and that could not work: South African
 * retail banks run a single universal branch code and mostly do not print it on
 * statements at all. A Discovery statement carries none anywhere on the page, so
 * the extraction had no `branchCode`, and the gate refused a payout whose
 * account number and bank both matched.
 *
 * Deriving the code from the bank and asserting it against the client record was
 * the obvious repair and is WRONG — it swaps one blocker for another. Banks
 * issued per-branch codes for years and still honour them, so a client holding a
 * legacy physical code would start failing a gate they pass today, for no gain.
 *
 * WHAT DROPPING THE LEG COSTS, stated accurately.
 *
 * The argument for removal was "the branch code is functionally determined by
 * the bank, so asserting bank AND branch asserts the bank twice". That is true
 * of South African banking. It is NOT an invariant this system enforces:
 * nothing validates `bankBranchCode` against `bankName` anywhere — the wizard
 * accepts any six digits (lib/validation/client-wizard.ts), and there is no
 * bank→code table. No `universalBranchCode` helper exists in lib/banks.ts to make
 * new records right by construction.
 *
 * So be clear about the state this leaves: after this change NOTHING binds the
 * payout branch code to any evidence — not this function, and not the DISBURSED
 * guard, which asserts only that it is non-null. The account number and the
 * canonical bank name still have to match the verified statement, and those cap
 * the damage: account numbers are not portable between banks, so a mismatched
 * branch code bounces rather than landing somewhere else. `disbursementBranchCode`
 * is also written and never read back — the EFT is performed by staff, so the
 * value is a record rather than a routing instruction.
 *
 * That is a real reduction in what this gate proves, accepted deliberately
 * because the alternative — asserting a derived code against the record — blocks
 * clients holding legacy per-branch codes, which banks still honour. If the
 * branch code is to be bound again, bind it to the BANK with a real table and a
 * migration path for legacy codes; do not restore the comparison against the
 * statement, which is what could not work in the first place.
 *
 * WHAT THIS FUNCTION ACTUALLY ENFORCES, exhaustively, so the next person
 * relaxing something knows what is left:
 *   1. the statement is verified and not flagged `validationMismatch`
 *   2. its bytes hash to the recorded sha256
 *   3. the extracted account number equals the record's
 *   4. the extracted bank canonicalises to the record's bank
 *   5. the extracted account type canonicalises to the record's — UNLESS the
 *      record says OTHER, which waives this leg, or the extraction states no
 *      account type at all (absent, or the extractor's OTHER non-answer), which
 *      is silence rather than contradiction and waives it too. An unrecognised
 *      PRODUCT name is not silence and still fails closed.
 *
 * The ACCOUNT HOLDER NAME is NOT enforced here. Do not describe it as enforced.
 * It is not compared in this function, and it is not reached indirectly through
 * `validationMismatch` either: `validateBankStatement` records a holder-name
 * mismatch at severity 'warning' (lib/ocr/documentValidationService.ts), and
 * `calculateResult` sets `isValid: criticalMismatches === 0`, so a warning never
 * sets the flag this function reads. The holder name is shown to the staff
 * member verifying the document — a human control, not an automated one. Do not
 * write it down as an automated check without first making it one.
 */
export function verifiedBankStatementEvidence(
  document: DebitMandateBankStatementDocument | null,
  bankDetails: PayoutBankDetails,
):
  | { ok: true; evidence: DebitMandateBankStatementEvidence }
  | {
      ok: false
      reason:
        | "verified_bank_statement_missing"
        | "verified_bank_statement_integrity_missing"
        | "verified_bank_statement_mismatch"
      /**
       * Which leg of the tuple failed, so staff are told what to fix instead of
       * one sentence covering every cause. `extraction_empty` is its own value
       * because it is the only one with a different remedy: a password-locked
       * PDF is never read at all, so nothing disagrees — there is simply
       * nothing there.
       */
      mismatchField?:
        | "extraction_empty"
        | "accountNumber"
        | "bankName"
        | "accountType"
    } {
  if (!document?.verifiedAt || document.validationMismatch) {
    return { ok: false, reason: "verified_bank_statement_missing" }
  }
  if (!isSha256Digest(document.contentSha256)) {
    return { ok: false, reason: "verified_bank_statement_integrity_missing" }
  }
  const extractedAccount = extractedFieldValue(
    document.extractionResult,
    "accountNumber",
  )?.replace(/\D/g, "")
  const extractedBank = extractedFieldValue(
    document.extractionResult,
    "bankName",
  )
  const extractedAccountType = extractedFieldValue(
    document.extractionResult,
    "accountType",
  )
  const mismatchField = payoutTupleMismatchField(
    { extractedAccount, extractedBank, extractedAccountType },
    bankDetails,
  )
  if (mismatchField) {
    return {
      ok: false,
      reason: "verified_bank_statement_mismatch",
      mismatchField,
    }
  }
  return {
    ok: true,
    evidence: {
      documentId: document.id,
      documentSha256: document.contentSha256,
      verifiedAt: document.verifiedAt.toISOString(),
    },
  }
}

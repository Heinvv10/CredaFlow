/**
 * The consumer bureau check for each director and trustee of a deal's entity
 * (goal decision 2a.3: no commercial bureau API in slice 1).
 *
 * WHY NOT runBureauReviewCheck. The consumer path (lib/compliance/
 * bureau-review.ts) only stores a result while the application is
 * UNDER_REVIEW for that same client in the current bureauReviewGeneration:
 * an entity application has no clientId, so every director's result would
 * be discarded as "stale". This module runs the SAME enquiry (runBureauEnquiry
 * over the tenant's bureau order, approval bureaus only — lib/bureau),
 * applies the SAME POPIA consent rule, and stores the same rows: one
 * CreditBureauCheck per bureau attempt (bureauCheckRow, so a simulated report
 * keeps its marker) and a CREDIT_BUREAU_CHECK ComplianceRecord per run, both
 * keyed to the deal's application. Keep the consent rule identical to
 * bureau-review.ts. A person's stored check is reused for the tenant's bureau
 * freshness window (TenantConfig.bureauMaxAgeDays): inside it, a report is
 * current, and a new enquiry would only mark their credit record again.
 *
 * A JURISTIC trustee (a company acting as trustee) is not a natural person
 * and gets no consumer check; it is listed as skipped.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { bureauSubjectFingerprint, type BureauSubjectClient } from "@/lib/compliance/bureau-subject"
import { isApprovalBureau } from "@/lib/compliance/bureau"
import { openBureauCredentials, type BureauCredentialMap } from "@/lib/bureau/credentials"
import { runBureauEnquiry } from "@/lib/bureau/enquiry"
import { bureauCheckRow } from "@/lib/bureau/persist"
import { DAY_MS, dealBureauConfig, type DealBureauConfig } from "./deal-bureau-window"

/**
 * "recent": a check stored for this application within the tenant's window;
 * "busy": a concurrent request held this person's check for longer than
 * LOCK_WAIT_MS. Neither made an enquiry.
 */
export type DealBureauOutcome = "stored" | "skipped" | "failed" | "recent" | "busy"

export { dealRecheckWindowDays, recentlyCheckedClientIds } from "./deal-bureau-window"

export interface DealBureauSubject {
  clientId: string
  role: "DIRECTOR" | "TRUSTEE"
  trusteeKind: "NATURAL" | "JURISTIC" | null
}

// The enquiry runs inside the transaction that holds the per-person lock.
// The wait for that lock is bounded (polled, LOCK_WAIT_MS), so the
// transaction's budget is the wait, the provider's own timeout
// (EXPERIAN_TIMEOUT_MS, 20 s) and the rows, well inside ENQUIRY_TRANSACTION_MS.
const ENQUIRY_TRANSACTION_MS = 60_000
const LOCK_WAIT_MS = 5_000
const LOCK_POLL_MS = 100

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type BureauDb = Pick<Tx, "client" | "complianceRecord" | "creditBureauCheck">

/** `data.provider` names the bureau: the one asked, or the tenant's primary when none was. */
async function recordAttempt(
  db: BureauDb,
  tenantId: string,
  applicationId: string,
  status: "ACKNOWLEDGED" | "PENDING",
  data: Prisma.InputJsonObject & { provider: string },
): Promise<void> {
  await db.complianceRecord.create({
    data: {
      tenantId,
      type: "CREDIT_BUREAU_CHECK",
      status,
      referenceId: applicationId,
      completedAt: status === "ACKNOWLEDGED" ? new Date() : null,
      data: { assetFinance: true, ...data },
    },
  })
}

/** The active DIRECTOR and TRUSTEE relationships of the entity, one per person and role. */
export async function dealBureauSubjects(tenantId: string, entityId: string): Promise<DealBureauSubject[]> {
  const rows = await prisma.entityRelationship.findMany({
    where: { tenantId, entityId, active: true, role: { in: ["DIRECTOR", "TRUSTEE"] } },
    orderBy: { createdAt: "asc" },
    select: { clientId: true, role: true, trusteeKind: true },
  })
  return rows.map((r) => ({ clientId: r.clientId, role: r.role as DealBureauSubject["role"], trusteeKind: r.trusteeKind }))
}

/**
 * One person's check for this application. Concurrent requests for the same
 * (application, person) queue on a transaction-scoped advisory lock held
 * across the stored-check lookup, the enquiry and its rows, so two requests
 * make one enquiry: the second sees the first's stored check and answers
 * "recent". The wait for the lock is bounded: after LOCK_WAIT_MS the request
 * answers "busy" without enquiring. Without `force` a check stored inside the
 * tenant's window is recent; with it, only one stored since this request
 * started (`startedAt`, i.e. by a concurrent request).
 *
 * An enquiry that was made is always recorded: it is on the person's credit
 * record whatever happens to its rows. If the transaction fails once the
 * provider call has begun (a store refused, a timeout, a lost connection),
 * everything it wrote is rolled back, so a failed attempt is recorded in a
 * transaction of its own before the error is rethrown.
 */
export async function runDealBureauCheck(
  tenantId: string,
  applicationId: string,
  subject: DealBureauSubject,
  opts: { force: boolean; startedAt: Date },
): Promise<DealBureauOutcome> {
  const { clientId } = subject
  const bureau = await dealBureauConfig(tenantId)
  const primary = bureau.order[0]
  if (subject.trusteeKind === "JURISTIC") {
    await recordAttempt(prisma, tenantId, applicationId, "ACKNOWLEDGED", { provider: primary, clientId, outcome: "skipped", reason: "JURISTIC_TRUSTEE" })
    return "skipped"
  }
  const since = opts.force ? opts.startedAt : new Date(opts.startedAt.getTime() - bureau.windowDays * DAY_MS)
  const enquiry: Enquiry = { made: false }
  try {
    return await prisma.$transaction(async (tx) => {
      if (!(await lockPerson(tx, `deal-bureau:${tenantId}:${applicationId}:${clientId}`))) return "busy"
      const current = await tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { id: true, idNumber: true, firstName: true, lastName: true, gender: true, dateOfBirth: true },
      })
      const subjectFingerprint = current ? bureauSubjectFingerprint(current as BureauSubjectClient) : "missing-subject"
      const stored = await tx.creditBureauCheck.count({
        where: { tenantId, applicationId, clientId, subjectFingerprint, ok: true, createdAt: { gte: since } },
      })
      return stored > 0 ? "recent" : enquire(tx, tenantId, applicationId, clientId, enquiry, bureau)
    }, { timeout: ENQUIRY_TRANSACTION_MS })
  } catch (error) {
    if (enquiry.made) await recordUnstoredEnquiry(tenantId, applicationId, clientId, enquiry.provider ?? primary, error)
    throw error
  }
}

/** Set once a provider call begins: from then on the enquiry may be on the person's credit record. */
interface Enquiry {
  made: boolean
  /** The bureau most recently asked. */
  provider?: string
}

/** The transaction-scoped advisory lock on `key`, polled for at most LOCK_WAIT_MS; false if it stayed held. */
async function lockPerson(tx: Tx, key: string): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>(
      Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS "locked"`,
    )
    if (row?.locked) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}

/**
 * The failed attempt of an enquiry whose transaction failed, written outside
 * it (the shape of the in-transaction failure record, plus enquiryMade). If
 * even this write fails, both errors are surfaced.
 */
async function recordUnstoredEnquiry(tenantId: string, applicationId: string, clientId: string, provider: string, error: unknown): Promise<void> {
  // jsonb refuses U+0000; the message is a diagnostic, so it is also capped.
  const reason = (error instanceof Error ? error.message : String(error)).replaceAll("\u0000", "").slice(0, 500)
  try {
    await recordAttempt(prisma, tenantId, applicationId, "PENDING", {
      provider,
      clientId,
      outcome: "failed",
      enquiryMade: true,
      error: `The enquiry was made but its result could not be stored: ${reason}`,
    })
  } catch (recordError) {
    throw new AggregateError([error, recordError], "A bureau enquiry was made but neither its result nor a failed attempt could be recorded")
  }
}

/**
 * The enquiry and its rows, in the caller's transaction. A lookup failure or
 * a bureau refusal is recorded; a failure to store the result rolls the
 * transaction back and propagates (runDealBureauCheck then records the
 * attempt outside it).
 */
async function enquire(
  db: BureauDb, tenantId: string, applicationId: string, clientId: string, enquiry: Enquiry, bureau: DealBureauConfig,
): Promise<DealBureauOutcome> {
  const primary = bureau.order[0]
  const client = await db.client.findFirst({
    where: { id: clientId, tenantId },
    select: {
      idNumber: true,
      firstName: true,
      lastName: true,
      gender: true,
      dateOfBirth: true,
      popiaConsentGiven: true,
      consent: { select: { id: true, creditBureauEnquiry: true, withdrawnAt: true } },
    },
  })
  if (!client) {
    await recordAttempt(db, tenantId, applicationId, "PENDING", { provider: primary, clientId, outcome: "failed", error: "client not found" })
    return "failed"
  }
  // POPIA gate, as lib/compliance/bureau-review.ts: granular consent is
  // authoritative when it exists; the umbrella flag is the legacy fallback.
  const granular = client.consent
  const consentGranted = granular ? granular.creditBureauEnquiry && granular.withdrawnAt === null : client.popiaConsentGiven
  if (!consentGranted) {
    const reason = granular ? (granular.withdrawnAt ? "CONSENT_WITHDRAWN" : "CONSENT_REFUSED") : "CONSENT_MISSING"
    await recordAttempt(db, tenantId, applicationId, "ACKNOWLEDGED", { provider: primary, clientId, outcome: "skipped", skipped: true, reason })
    return "skipped"
  }

  const identity = {
    idNumber: client.idNumber,
    firstName: client.firstName,
    lastName: client.lastName,
    gender: client.gender,
    dateOfBirth: client.dateOfBirth,
  }
  let credentials: BureauCredentialMap | null = null
  const run = await runBureauEnquiry({
    request: {
      tenantId,
      consumer: { ...identity, gender: client.gender === "MALE" ? "M" : client.gender === "FEMALE" ? "F" : null },
      purpose: "AFFORDABILITY_ASSESSMENT",
      consent: { reference: granular ? `ClientConsent:${granular.id}` : `Client.popiaConsentGiven:${clientId}` },
      reference: applicationId,
    },
    order: bureau.order,
    credentialsFor: (providerId) => {
      credentials ??= openBureauCredentials(bureau.credentials)
      return credentials[providerId] ?? null
    },
    // A director's report feeds the deal decision: approval bureaus only.
    eligible: isApprovalBureau,
    beforeAttempt: async () => {
      enquiry.made = true
      return true
    },
  })
  const subjectFingerprint = bureauSubjectFingerprint({ id: clientId, ...identity })
  for (const attempt of run.attempts) {
    if (attempt.status !== "SKIPPED_NOT_APPROVABLE") enquiry.provider = attempt.provider
    await db.creditBureauCheck.create({
      data: bureauCheckRow({ tenantId, clientId, applicationId, reviewGeneration: null, subjectFingerprint }, attempt),
    })
  }
  const report = run.report?.report ?? null
  const last = run.attempts.findLast((a) => a.status !== "SKIPPED_NOT_APPROVABLE") ?? run.attempts[run.attempts.length - 1]
  await db.complianceRecord.create({
    data: {
      tenantId,
      type: "CREDIT_BUREAU_CHECK",
      status: report ? "COMPLETED" : "PENDING",
      referenceId: applicationId,
      completedAt: report ? new Date() : null,
      data: {
        provider: last.provider,
        assetFinance: true,
        clientId,
        // This run's results are the CreditBureauCheck rows above.
        withCheck: true,
        outcome: report ? "stored" : "failed",
        score: report?.score?.value ?? null,
        riskGrade: report?.score?.riskGrade ?? null,
        error: last.status === "OK" ? null : last.error,
        attempts: run.attempts.map((a) => ({ attempt: a.attempt, provider: a.provider, status: a.status })),
      },
    },
  })
  return report ? "stored" : "failed"
}

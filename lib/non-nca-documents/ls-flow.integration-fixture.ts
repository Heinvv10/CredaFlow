/**
 * The steps of a Lesotho loan through the real routes, for the suites that mock what ls-end-to-end.integration.test.ts mocks: an
 * UNDER_REVIEW application, decide, the in-person KYC attestation, issue, acknowledge, sign, the second person, disburse. Not a test file.
 */
import { NextRequest } from "next/server"
import type { PrismaClient } from "@prisma/client"
import { expect } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { POST as decide } from "@/app/api/applications/[id]/decide/route"
import { POST as disburse } from "@/app/api/applications/[id]/disburse/route"
import { POST as verifyPayoutAccount } from "@/app/api/applications/[id]/payout-account-verification/route"
import { POST as attestInPerson } from "@/app/api/clients/[id]/kyc-in-person-verification/route"
import { acknowledgeKeyFacts } from "./acknowledge"
import { issueLoanDocuments } from "./issue"
import { signKeyFactsAgreement } from "./sign"
import { loanDocumentState } from "./state"
import { clearOpenFlags, seedUnderReview, type Stack } from "./ls-stack.integration-fixture"

/** Who the mocked session guard says is calling, and the mocked storage (see the suites' vi.mock blocks). */
export interface FlowHolder { userId: string; role: string; files: Map<string, Buffer> }
export const NOTE = "Confirmed the account with the borrower's bank by telephone."
/** A reference pays one loan, so each application has its own. */
export const bankRefFor = (id: string) => `LS-${id}`

export function lsFlow(db: () => PrismaClient, stack: Stack, holder: FlowHolder) {
  const post = (route: typeof decide, id: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
    route(new NextRequest(`http://localhost/api/x/${id}/x`, { method: "POST", body, headers }), { params: Promise.resolve({ id }) })
  const postJson = (route: typeof decide, id: string, body: unknown) => post(route, id, JSON.stringify(body), { "content-type": "application/json" })
  const as = (userId: string, role = "LOAN_ADMIN") => { holder.userId = userId; holder.role = role }
  const decideForm = (id: string, fields: Record<string, string>) => {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    as(stack.officer)
    return post(decide, id, form)
  }
  const disburseAs = (userId: string, id: string, body: { bankRef?: unknown } = { bankRef: bankRefFor(id) }) => {
    as(userId)
    return postJson(disburse, id, body)
  }
  const verifyAccount = (userId: string, id: string, note: unknown = NOTE) => {
    as(userId)
    return postJson(verifyPayoutAccount, id, { note })
  }

  /** The route a borrower without a biometric takes to payout-grade KYC: a named senior attests they compared them to the ID. */
  async function attestKyc(id: string) {
    as(stack.senior, "ADMIN")
    const res = await postJson(attestInPerson, `${id}-client`, { method: "IN_PERSON_BRANCH", note: "Compared the borrower to the ID at the branch." })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  }

  /** An UNDER_REVIEW key-facts application, approved through the real route by the officer. */
  async function approvedApplication(id: string, opts: { documents?: boolean; bank?: boolean; kyc?: boolean; dealerId?: string } = {}) {
    const { statement } = await seedUnderReview(db(), stack, id, { nca: false, ...opts })
    holder.files.set(statement.path, statement.bytes)
    await clearOpenFlags(db(), stack, id)
    const res = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    if (opts.kyc !== false) await attestKyc(id)
  }

  /** Issue, acknowledge and sign: what the staff panel and the borrower's portal do (in the request's tenant frame, as the routes do). */
  async function issueAndSign(id: string) {
    const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(stack.tenant, fn)
    const issued = await inTenant(() => issueLoanDocuments({ tenantId: stack.tenant, applicationId: id, staff: { id: stack.officer, email: `${stack.officer}@test.invalid` } }))
    expect(issued).toMatchObject({ ok: true })
    const docs = (await inTenant(() => loanDocumentState(stack.tenant, id)))!.keyFacts!.documents
    const base = { tenantId: stack.tenant, applicationId: id, clientId: `${id}-client`, clientEmail: `${id}@test.invalid` }
    expect(await inTenant(() => acknowledgeKeyFacts({ ...base, shown: docs.find((d) => d.kind === "KEY_FACTS_STATEMENT")!.pdfSha256 }))).toMatchObject({ ok: true })
    expect(await inTenant(() => signKeyFactsAgreement({
      ...base, agreementDocumentSha256: docs.find((d) => d.kind === "LOAN_AGREEMENT")!.pdfSha256, signature: "Synthetic Borrower", signingOtpChallengeId: null, ipAddress: "203.0.113.9",
    }))).toMatchObject({ ok: true })
  }

  /** Approved and signed; unless `verified: false`, a second person (the officer) has confirmed the payout account. */
  async function signedApplication(id: string, opts: { documents?: boolean; bank?: boolean; kyc?: boolean; verified?: boolean; dealerId?: string } = {}) {
    await approvedApplication(id, opts)
    await issueAndSign(id)
    if (opts.verified !== false && opts.bank !== false) expect((await verifyAccount(stack.officer, id)).status).toBe(200)
  }

  return { as, decideForm, disburseAs, verifyAccount, attestKyc, approvedApplication, issueAndSign, signedApplication }
}

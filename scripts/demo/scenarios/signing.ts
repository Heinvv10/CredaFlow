/**
 * Steps 7–10 — the signing ceremony and payout, in the order the routes
 * enforce:
 *
 *   PASQ       staff issue it (POST …/pasq, needs an APPROVED application and
 *              payout-grade KYC); the borrower opens it in the portal (GET
 *              …/pasq) and acknowledges those exact bytes (POST
 *              …/pasq/acknowledge with their SHA-256).
 *   agreement  staff generate it (POST …/agreement); the borrower opens it
 *              (GET …/agreement) and signs in the portal, echoing both
 *              document digests (POST …/agreement/sign, method "portal");
 *              an admin countersigns (POST …/agreement/countersign).
 *   mandate    the borrower confirms banking (POST …/debit-mandate → draft
 *              digest) and signs that draft (POST …/debit-mandate/sign).
 *   code       before each portal signature the borrower asks for a signing
 *              code by email (POST /api/signing-otp), reads it off the screen
 *              (the demo stack's .invalid mailboxes are revealed, DEMO_MODE),
 *              verifies it (POST …/verify) and signs with it — the lender's
 *              requireSigningOtp is left on, so the demo shows the feature.
 *   payout     a second staff member disburses (POST …/disburse), which books
 *              the Loan: the context's disburser, else the admin.
 *
 * Each digest the borrower echoes is computed here from the bytes the portal
 * served, so a signature is bound to what was actually opened.
 */
import { createHash } from "node:crypto"
import { AGREEMENT_DECLARATION_PAYLOAD } from "../../../lib/signing/agreement-declaration-set"

import type { Persona } from "../personas"
import { ApiError, type SimClient } from "../sim/api"
import { log } from "../sim/env"
import { ensureStaffSessions, type OriginationContext } from "./context"

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** GETs a document as `actor` and returns the SHA-256 of the bytes served. */
async function openDocument(actor: SimClient, path: string): Promise<{ sha: string; header: string | null }> {
  const res = await actor.get(path, { headers: { accept: "application/pdf" } })
  if (!(res.headers.get("content-type") ?? "").includes("application/pdf")) {
    throw new Error(`${path} served ${res.headers.get("content-type")}, not a PDF`)
  }
  return { sha: sha256(res.bytes), header: res.headers.get("x-document-sha256") }
}

/**
 * Requests, reads (demo reveal) and verifies a signing code for exactly these
 * bytes, and returns the challenge to sign with. Fails loudly when the stack
 * does not reveal the code: a signature without one is refused anyway.
 */
async function verifiedSigningCode(
  portal: SimClient,
  purpose: "AGREEMENT" | "DEBIT_MANDATE",
  subjectId: string,
  documentSha256: string,
): Promise<string> {
  const issued = await portal.post<{ challengeId?: string; demoCode?: string }>("/api/signing-otp", {
    purpose, subjectId, documentSha256, channel: "EMAIL",
  })
  const { challengeId, demoCode } = issued.json ?? {}
  if (!challengeId || !demoCode) {
    throw new Error(`signing code not revealed (is DEMO_MODE=true and the borrower's mailbox .invalid?): ${issued.text.slice(0, 300)}`)
  }
  await portal.post(`/api/signing-otp/${challengeId}/verify`, { code: demoCode })
  log(`${purpose.toLowerCase()} signing code verified`)
  return challengeId
}

export async function issuePasq(ctx: OriginationContext, applicationId: string): Promise<string> {
  const issued = await ctx.officer.post<{ documentSha256: string }>(`/api/applications/${applicationId}/pasq`)
  const issuedSha = issued.json?.documentSha256
  if (!issuedSha) throw new Error(`PASQ issue returned no digest: ${issued.text.slice(0, 300)}`)
  log(`PASQ issued ${issuedSha.slice(0, 12)}…`)
  return issuedSha
}

export async function acknowledgePasq(portal: SimClient, applicationId: string, issuedSha: string): Promise<string> {
  const opened = await openDocument(portal, `/api/applications/${applicationId}/pasq`)
  if (opened.sha !== issuedSha || opened.header !== issuedSha) {
    throw new Error(`PASQ served ${opened.sha} (header ${opened.header}) but ${issuedSha} was issued`)
  }
  await portal.post(`/api/applications/${applicationId}/pasq/acknowledge`, { documentSha256: opened.sha })
  log(`PASQ acknowledged by the borrower`)
  return opened.sha
}

/**
 * Generates the agreement. When finalization fails and the route reports it
 * cleaned up after itself (500, agreementIntegrity "staging_failed" — seen when
 * the shared host is loaded and the finalization transaction overruns
 * Prisma's 5 s limit), the officer presses Generate again, once.
 */
export async function generateAgreement(ctx: OriginationContext, applicationId: string): Promise<void> {
  const path = `/api/applications/${applicationId}/agreement`
  try {
    await ctx.officer.post(path, {})
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 500 && err.body.includes('"agreementIntegrity":"staging_failed"'))) throw err
    log(`agreement generation failed and was cleaned up (${err.body.slice(0, 160)}); generating again`)
    await ctx.officer.post(path, {})
  }
  log(`credit agreement generated`)
}

export async function signAgreement(
  portal: SimClient,
  p: Persona,
  applicationId: string,
  pasqSha: string,
): Promise<void> {
  const agreement = await openDocument(portal, `/api/applications/${applicationId}/agreement`)
  const signingOtpChallengeId = await verifiedSigningCode(portal, "AGREEMENT", applicationId, agreement.sha)
  await portal.post(`/api/applications/${applicationId}/agreement/sign`, {
    method: "portal",
    signature: `${p.firstName} ${p.lastName}`,
    agreementDocumentSha256: agreement.sha,
    pasqDocumentSha256: pasqSha,
    signingOtpChallengeId,
    declarations: AGREEMENT_DECLARATION_PAYLOAD,
  })
  log(`${p.id}: agreement signed in the portal`)
}

export async function countersignAgreement(ctx: OriginationContext, applicationId: string): Promise<void> {
  const signer = ctx.admin.user?.name ?? ctx.admin.user?.email
  if (!signer) throw new Error("admin session has no name to countersign with")
  await ctx.admin.post(`/api/applications/${applicationId}/agreement/countersign`, {
    signature: signer,
    attestation: true,
  })
  log(`agreement countersigned by ${signer}`)
}

export async function signDebitMandate(portal: SimClient, p: Persona, applicationId: string): Promise<void> {
  const draft = await portal.post<{ draftDocumentSha256?: string }>(`/api/applications/${applicationId}/debit-mandate`, {
    bankName: p.bank.bankCode,
    branchCode: p.bank.branchCode,
    accountNumber: p.bank.accountNumber,
    accountType: p.bank.accountType,
  })
  const draftSha = draft.json?.draftDocumentSha256
  if (!draftSha) throw new Error(`debit mandate prepare returned no draft digest: ${draft.text.slice(0, 300)}`)
  const signingOtpChallengeId = await verifiedSigningCode(portal, "DEBIT_MANDATE", applicationId, draftSha)
  await portal.post(`/api/applications/${applicationId}/debit-mandate/sign`, {
    signature: `${p.firstName} ${p.lastName}`,
    draftDocumentSha256: draftSha,
    signingOtpChallengeId,
  })
  log(`${p.id}: debit mandate signed`)
}

/** Pays out as the context's disburser, a second staff member, when it has one. */
export async function disburse(ctx: OriginationContext, applicationId: string): Promise<{ loanId: string; loanRef: string }> {
  await ensureStaffSessions(ctx)
  const payer = ctx.disburser?.client ?? ctx.admin
  const res = await payer.post<{ loanId: string; loanRef: string }>(`/api/applications/${applicationId}/disburse`, {
    bankRef: "",
  })
  if (!res.json?.loanRef || !res.json.loanId) throw new Error(`disburse returned no loan: ${res.text.slice(0, 300)}`)
  log(`DISBURSED — loan ${res.json.loanRef}`)
  return { loanId: res.json.loanId, loanRef: res.json.loanRef }
}

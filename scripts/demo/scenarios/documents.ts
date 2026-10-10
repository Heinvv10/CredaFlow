/**
 * Steps 2–3 — documents and identity.
 *
 * The borrower uploads the persona's SPECIMEN documents in the portal (POST
 * /api/documents, as the portal upload dialog does); extraction runs on the
 * real VLM and validates each document against the client record. The
 * simulator polls the same list the portal polls, then a credit officer
 * verifies each document (PATCH …/documents/[docId]/verify) only when its
 * extraction finished without a critical mismatch — a misread is reported,
 * never verified over.
 *
 * PROOF_OF_ADDRESS is one of the four core KYC documents. The specimens carry
 * no utility bill, so the bank statement (which prints the residential
 * address) is uploaded a second time as proof of address — the extraction
 * prompt for that type explicitly accepts a bank statement.
 *
 * Identity: the selfie biometric is a VLM face match against the ID photo
 * (lib/kyc/selfie-biometric.server.ts — Smile is not in that path), and the
 * specimen ID card has no photograph, so a selfie cannot pass. The product's
 * substitute is an in-person verification recorded by an ADMIN, which is
 * what this scenario records.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import type { Persona } from "../personas"
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { generateSpecimens, type ManifestDocument } from "../specimens"
import type { OriginationContext } from "./context"

export interface StoredDocument {
  id: string
  docType: string
  fileName: string
  contentSha256: string | null
  extractionStatus: string
  extractionError: string | null
  validationMismatch: boolean | null
  validationScore: number | null
  validationResult: { mismatches?: Array<{ severity: string; message: string }> } | null
  verified: boolean
}

const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000
const POLL_MS = 3000

interface Upload {
  file: ManifestDocument
  docType: "ID_COPY" | "PAYSLIP" | "BANK_STATEMENT" | "PROOF_OF_ADDRESS"
}

/** Generates the persona's specimens dated `asOf` and uploads them from the portal. */
export async function uploadDocuments(
  ctx: OriginationContext,
  portal: SimClient,
  p: Persona,
  asOf: string,
): Promise<string[]> {
  const manifest = await generateSpecimens(p, asOf, ctx.specimensRoot)
  const uploads: Upload[] = manifest.documents.map((file) => ({ file, docType: file.docType }))
  const statement = manifest.documents.find((d) => d.docType === "BANK_STATEMENT")
  if (!statement) throw new Error(`${p.id}: specimens have no bank statement`)
  uploads.push({ file: statement, docType: "PROOF_OF_ADDRESS" })

  const ids: string[] = []
  for (const { file, docType } of uploads) {
    const bytes = readFileSync(path.join(ctx.specimensRoot, p.id, file.file))
    const form = new FormData()
    form.set("file", new File([bytes], file.file, { type: file.mimeType }))
    form.set("docType", docType)
    const res = await portal.post<{ id: string; contentSha256: string }>("/api/documents", form, { expect: [201] })
    if (!res.json?.id) throw new Error(`upload ${file.file} returned no id`)
    if (res.json.contentSha256 !== file.sha256) {
      throw new Error(`upload ${file.file}: stored sha256 ${res.json.contentSha256} != generated ${file.sha256}`)
    }
    ids.push(res.json.id)
    log(`${p.id}: uploaded ${docType} ${file.file}`)
  }
  return ids
}

/** Polls the client's document list (as the portal does) until every id has left `processing`. */
export async function awaitExtraction(portal: SimClient, clientId: string, ids: string[]): Promise<StoredDocument[]> {
  const deadline = Date.now() + EXTRACTION_TIMEOUT_MS
  for (;;) {
    const docs = (await portal.get<StoredDocument[]>(`/api/clients/${clientId}/documents`)).json ?? []
    const mine = docs.filter((d) => ids.includes(d.id))
    if (mine.length === ids.length && mine.every((d) => d.extractionStatus !== "processing")) return mine
    if (Date.now() > deadline) throw new Error(`extraction did not finish within ${EXTRACTION_TIMEOUT_MS / 60000} min`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

function describe(d: StoredDocument): string {
  const issues = (d.validationResult?.mismatches ?? []).map((m) => `${m.severity}: ${m.message}`)
  return `${d.docType} ${d.fileName} extraction=${d.extractionStatus} mismatch=${d.validationMismatch} score=${d.validationScore}` +
    (d.extractionError ? ` error=${d.extractionError}` : "") +
    (issues.length > 0 ? ` [${issues.join("; ")}]` : "")
}

/**
 * A failed extraction (the VLM is shared and occasionally drops a request) is
 * re-run once by the officer with the documents tab's Extract action (POST
 * /api/documents/[id]/extract, synchronous). A document that fails again is
 * left failed for verifyDocuments to report.
 */
export async function retryFailedExtractions(
  ctx: OriginationContext,
  portal: SimClient,
  clientId: string,
  docs: StoredDocument[],
): Promise<StoredDocument[]> {
  const failed = docs.filter((d) => d.extractionStatus === "failed")
  if (failed.length === 0) return docs
  for (const d of failed) {
    log(`  re-extracting ${d.docType} ${d.fileName} (${d.extractionError ?? "no error recorded"})`)
    await ctx.officer.post(`/api/documents/${d.id}/extract`, undefined, { expect: [200, 422] })
  }
  return awaitExtraction(portal, clientId, docs.map((d) => d.id))
}

/** The officer verifies each extracted, critically-matching document. */
export async function verifyDocuments(ctx: OriginationContext, clientId: string, docs: StoredDocument[]): Promise<void> {
  for (const d of docs) log(`  ${describe(d)}`)
  const refused = docs.filter((d) => d.extractionStatus !== "done" || d.validationMismatch !== false)
  if (refused.length > 0) {
    throw new Error(`documents not verifiable as extracted:\n  ${refused.map(describe).join("\n  ")}`)
  }
  for (const d of docs) {
    await ctx.officer.patch(`/api/clients/${clientId}/documents/${d.id}/verify`, {
      verified: true,
      note: `Checked against the client record; extraction matched (score ${d.validationScore}).`,
    })
  }
  log(`verified ${docs.length} documents`)
}

/** ADMIN records the in-person identity check (no selfie attempted). */
export async function recordInPersonVerification(ctx: OriginationContext, p: Persona, clientId: string): Promise<void> {
  await ctx.admin.post(`/api/clients/${clientId}/kyc-in-person-verification`, {
    method: "IN_PERSON_BRANCH",
    note: `${p.firstName} ${p.lastName} attended the branch; face compared to the ID document on file and ID number confirmed.`,
  })
  log(`${p.id}: in-person identity verification recorded`)
}

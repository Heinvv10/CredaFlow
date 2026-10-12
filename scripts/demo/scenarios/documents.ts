/**
 * Steps 2–3 — documents and identity.
 *
 * The borrower uploads the persona's SPECIMEN documents in the portal (POST
 * /api/documents, as the portal upload dialog does); extraction runs on the
 * real VLM and validates each document against the client record. The VLM is
 * shared with production, so uploads go one at a time through sim/vlm-gate.ts:
 * each waits for the previous document's extraction to finish (polling the
 * same list the portal polls) and a failed one is re-extracted with backoff
 * before the next is uploaded. Then a credit officer
 * verifies each document (PATCH …/documents/[docId]/verify) only when its
 * extraction finished without a critical mismatch — a misread is reported,
 * never verified over.
 *
 * PROOF_OF_ADDRESS is one of the four core KYC documents. The specimens carry
 * no utility bill, so the bank statement (which prints the residential
 * address) is uploaded a second time as proof of address — the extraction
 * prompt for that type explicitly accepts a bank statement.
 *
 * Identity: the selfie biometric compares the selfie with the ID photo (a face
 * model decides same-person, VLM gates can refuse;
 * lib/kyc/selfie-biometric.server.ts — Smile is not in that path), and the
 * specimen ID card has no photograph, so a selfie cannot pass. The product's
 * substitute is an in-person verification recorded by an ADMIN, which is
 * what this scenario records.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import type { Persona } from "../personas"
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { extractWithRetry, vlmSlot, type ExtractionAttempt } from "../sim/vlm-gate"
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
/** One document: the app aborts its VLM call at 55 s; the rest is rasterising and the DB. */
const DOCUMENT_TIMEOUT_MS = 3 * 60 * 1000
const DOCUMENT_POLL_MS = 1000

interface Upload {
  file: ManifestDocument
  docType: "ID_COPY" | "PAYSLIP" | "BANK_STATEMENT" | "PROOF_OF_ADDRESS"
}

async function listDocuments(portal: SimClient, clientId: string): Promise<StoredDocument[]> {
  return (await portal.get<StoredDocument[]>(`/api/clients/${clientId}/documents`)).json ?? []
}

/** Waits for one document to leave `processing`; done (or skipped: no VLM configured) is not retried. */
async function documentSettled(portal: SimClient, clientId: string, id: string): Promise<ExtractionAttempt> {
  const deadline = Date.now() + DOCUMENT_TIMEOUT_MS
  for (;;) {
    const d = (await listDocuments(portal, clientId)).find((x) => x.id === id)
    if (!d) return { ok: false, reason: `document ${id} is not in the client's list` }
    if (d.extractionStatus === "failed") return { ok: false, reason: d.extractionError ?? "failed, no error recorded" }
    if (d.extractionStatus !== "processing") return { ok: true }
    if (Date.now() > deadline) return { ok: false, reason: `still processing after ${DOCUMENT_TIMEOUT_MS / 60000} min` }
    await new Promise((r) => setTimeout(r, DOCUMENT_POLL_MS))
  }
}

/**
 * The documents tab's Extract action (POST /api/documents/[id]/extract,
 * synchronous). While the app's own attempt is still processing, a second
 * request would overlap it, so this keeps waiting for that one instead.
 */
async function reExtract(ctx: OriginationContext, portal: SimClient, clientId: string, id: string): Promise<ExtractionAttempt> {
  const d = (await listDocuments(portal, clientId)).find((x) => x.id === id)
  if (d?.extractionStatus === "processing") return documentSettled(portal, clientId, id)
  const res = await ctx.officer.post<{ error?: string }>(`/api/documents/${id}/extract`, undefined, { expect: [200, 409, 422] })
  if (res.status === 200) return { ok: true }
  return { ok: false, reason: `re-extract answered ${res.status}: ${res.json?.error ?? res.text.slice(0, 200)}` }
}

/**
 * Generates the persona's specimens dated `asOf` and uploads them from the
 * portal, one VLM slot per document: upload, wait for its extraction, retry.
 */
export async function uploadDocuments(
  ctx: OriginationContext,
  portal: SimClient,
  p: Persona,
  clientId: string,
  asOf: string,
): Promise<string[]> {
  const manifest = await generateSpecimens(p, asOf, ctx.specimensRoot)
  const uploads: Upload[] = manifest.documents.map((file) => ({ file, docType: file.docType }))
  const statement = manifest.documents.find((d) => d.docType === "BANK_STATEMENT")
  if (!statement) throw new Error(`${p.id}: specimens have no bank statement`)
  uploads.push({ file: statement, docType: "PROOF_OF_ADDRESS" })

  const ids: string[] = []
  for (const { file, docType } of uploads) {
    const label = `${p.id} ${docType} ${file.file}`
    ids.push(await vlmSlot(label, async () => {
      const bytes = readFileSync(path.join(ctx.specimensRoot, p.id, file.file))
      const form = new FormData()
      form.set("file", new File([bytes], file.file, { type: file.mimeType }))
      form.set("docType", docType)
      const res = await portal.post<{ id: string; contentSha256: string }>("/api/documents", form, { expect: [201] })
      if (!res.json?.id) throw new Error(`upload ${file.file} returned no id`)
      if (res.json.contentSha256 !== file.sha256) {
        throw new Error(`upload ${file.file}: stored sha256 ${res.json.contentSha256} != generated ${file.sha256}`)
      }
      const id = res.json.id
      log(`${p.id}: uploaded ${docType} ${file.file}`)
      await extractWithRetry(
        label,
        () => documentSettled(portal, clientId, id),
        () => reExtract(ctx, portal, clientId, id),
      )
      return id
    }))
  }
  return ids
}

/** Polls the client's document list (as the portal does) until every id has left `processing`. */
export async function awaitExtraction(portal: SimClient, clientId: string, ids: string[]): Promise<StoredDocument[]> {
  const deadline = Date.now() + EXTRACTION_TIMEOUT_MS
  for (;;) {
    const docs = await listDocuments(portal, clientId)
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
 * A document still failed when its verification step runs (a resumed run that
 * stopped mid-upload) is re-run by the officer with the documents tab's
 * Extract action, through the same slot and backoff as an upload. One that
 * fails every retry fails the persona.
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
    const label = `${d.docType} ${d.fileName}`
    const run = () => reExtract(ctx, portal, clientId, d.id)
    await vlmSlot(label, () => extractWithRetry(label, run, run))
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

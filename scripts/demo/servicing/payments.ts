/**
 * Money in, through the screens staff use (all HTTP; the UI's own calls):
 *
 *   receipt       Payments → Capture (QuickPaymentCapture / PaymentForm):
 *                 POST /api/payments with an Idempotency-Key. The key is
 *                 derived from the simulator's event id, so a resumed run
 *                 replays rather than double-books a receipt.
 *   debit orders  Payments → Bulk upload (BulkUpload.tsx): the day's debit-
 *                 order run results, one row per collected instalment,
 *                 POST /api/payments/bulk-upload (LOAN_ADMIN). Netcash's
 *                 adapter in this product only does AVS; collection results
 *                 come back to the lender as a file staff upload.
 *   reversal      Payments → Reverse (PaymentsClient.tsx): a debit order the
 *                 bank later returned unpaid, PATCH /api/payments/[id]/reverse.
 *   settlement    The client asks for a certificate of balance (Loan →
 *                 Certificate of balance, LoanDocumentActions.tsx), and staff
 *                 take the amount to pay from the loan page's capture form
 *                 ("Settlement Amount Today", s125 pricing). The certificate
 *                 prints "Total Amount to Settle" only while default charges are
 *                 live; when it does, the two must agree.
 */
import { execFileSync } from "node:child_process"

import type { SimClient } from "../sim/api"
import { log } from "../sim/env"

export type ReceiptMethod = "EFT" | "CASH" | "DEBIT_ORDER" | "CARD"

export interface Receipt {
  id: string
  allocationStatus: string
  refundDueAmount: number
}

export interface ReceiptInput {
  loanId: string
  amountCents: number
  method: ReceiptMethod
  reference: string
  notes?: string
  /** YYYY-MM-DD value date when the money landed before today (the form's date field). */
  receivedDay?: string
  /** Stable per simulated action (16–128 chars of [A-Za-z0-9._:-]). */
  idempotencyKey: string
}

export async function recordReceipt(actor: SimClient, r: ReceiptInput): Promise<Receipt> {
  const res = await actor.post<Receipt>("/api/payments", {
    loanId: r.loanId,
    amount: r.amountCents,
    paymentMethod: r.method,
    reference: r.reference,
    notes: r.notes ?? null,
    ...(r.receivedDay ? { receivedAt: r.receivedDay } : {}),
  }, { headers: { "Idempotency-Key": r.idempotencyKey }, expect: [200] })
  const receipt = res.json
  if (!receipt?.id) throw new Error(`POST /api/payments returned no payment: ${res.text.slice(0, 300)}`)
  if (receipt.refundDueAmount > 0) log(`receipt ${receipt.id}: R${receipt.refundDueAmount / 100} refund-due`)
  return receipt
}

export interface DebitOrderRow {
  loanRef: string
  amountCents: number
  /** Bank's debit-order trace reference. */
  paymentRef: string
}

interface BulkResult {
  processed: number
  skipped: number
  errors: Array<{ row: number; reference: string; reason: string }>
  payments: Array<{ id: string; loanRef: string; amount: number }>
  held: Array<{ loanRef: string; reason: string }>
}

/** Uploads one debit-order run's successful collections; returns payment ids by loan reference. */
export async function uploadDebitOrderResults(actor: SimClient, runDay: string, rows: DebitOrderRow[]): Promise<Map<string, string>> {
  const res = await actor.post<BulkResult>("/api/payments/bulk-upload", {
    rows: rows.map((r) => ({
      reference: r.loanRef,
      amount: r.amountCents / 100,
      method: "DEBIT_ORDER",
      paymentRef: r.paymentRef,
      notes: `Debit order run ${runDay}`,
    })),
  }, { expect: [200] })
  const result = res.json
  if (!result) throw new Error(`bulk upload returned no JSON: ${res.text.slice(0, 300)}`)
  if (result.errors.length > 0 || result.held.length > 0 || result.processed !== rows.length) {
    throw new Error(`debit-order run ${runDay} not fully booked: ${JSON.stringify({ errors: result.errors, held: result.held, processed: result.processed })}`)
  }
  log(`debit-order run ${runDay}: ${result.processed} collection(s) booked`)
  return new Map(result.payments.map((p) => [p.loanRef, p.id]))
}

export async function reversePayment(actor: SimClient, paymentId: string, reason: string): Promise<void> {
  await actor.patch(`/api/payments/${paymentId}/reverse`, { reason }, { expect: [200] })
  log(`payment ${paymentId} reversed: ${reason}`)
}

const rands = (raw: string): number => Math.round(Number(raw.replace(/,/g, "")) * 100)

/** Opens the certificate of balance, then reads today's settlement amount off the loan page; cents. */
export async function settlementAmount(actor: SimClient, loanId: string): Promise<number> {
  const cob = await actor.get(`/api/loans/${loanId}/certificate-of-balance`, { headers: { accept: "application/pdf" } })
  if (!(cob.headers.get("content-type") ?? "").includes("application/pdf")) {
    throw new Error(`certificate of balance for ${loanId} is ${cob.headers.get("content-type")}, not a PDF`)
  }
  const text = execFileSync("pdftotext", ["-layout", "-", "-"], { input: Buffer.from(cob.bytes), encoding: "utf8" })
  const onCertificate = /Total Amount to Settle\s+R\s?([\d,]+\.\d{2})/.exec(text)

  const page = await actor.get(`/loans/${loanId}`, { headers: { accept: "text/html" } })
  const onPage = /Settlement Amount Today<\/p><p[^>]*>R\s?([\d,]+\.\d{2})</.exec(page.text)
  if (!onPage) throw new Error(`loan page for ${loanId} shows no "Settlement Amount Today"`)
  const amount = rands(onPage[1])
  if (onCertificate && rands(onCertificate[1]) !== amount) {
    throw new Error(`certificate says R${onCertificate[1]} to settle, the loan page R${onPage[1]}`)
  }
  return amount
}

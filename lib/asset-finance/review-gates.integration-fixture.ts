/**
 * Real-Postgres fixture for the review-gates suites: the booking fixture with
 * every required checklist item of both deals confirmed through the real
 * route; deal B paid out (single approver) and BOOKED; deal A's payout
 * created PENDING_APPROVAL (dual approval), refused at booking, approved by
 * a second user, its bank account then superseded by a newly approved one
 * and refused at booking again — so deal A stays CONTRACTED with an APPROVED
 * payout. Every value is synthetic. Not a test file.
 *
 * Each database rule is then probed by `refusedSql` / `acceptedSql`: ONE psql
 * transaction that builds the state the rule guards with triggers off
 * (session_replication_role = replica; CHECKs still apply), runs the attempt
 * with triggers on (or off, to reach a CHECK alone), and always rolls back.
 * The database's own error text is what the suites assert on.
 */
import { spawnSync } from "node:child_process"
import type { PayoutChecklistItemKind, PrismaClient } from "@prisma/client"
import { expect } from "vitest"
import { bookingRoutes, createBookingFixture, dealDocument, type BookingFixture, type SetSession } from "./payout-booking.integration-fixture"

export interface ReviewGatesFixture extends BookingFixture {
  loanB: string
  assetA: string
  assetB: string
  newAccountId: string
}

const EVIDENCE: Partial<Record<PayoutChecklistItemKind, Parameters<typeof dealDocument>[3]>> = {
  SUPPLIER_INVOICE_MATCHES_ASSET: "SUPPLIER_INVOICE", SUPPLIER_BANK_VERIFIED: "BANK_STATEMENT", INSURANCE_NOTES_LENDER: "INSURANCE_NOTING",
  TRACKER_CONFIRMED: "TRACKER_CERTIFICATE", DELIVERY_AND_ACCEPTANCE: "DELIVERY_ACCEPTANCE", NATIS_TITLEHOLDER: "NATIS_DOCUMENT",
}

export async function createReviewGatesFixture(db: PrismaClient, t: string, setSession: SetSession): Promise<ReviewGatesFixture> {
  const fx = await createBookingFixture(db, t, setSession)
  const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@gates-it.test`, role, tenantId: fx.tenantId })
  const routes = bookingRoutes(fx.host)
  const assets: Record<string, string> = {}
  for (const dealId of [fx.dealId, fx.dealB]) {
    const deal = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: dealId }, include: { asset: true } })
    assets[dealId] = deal.assetId
    for (const row of await db.payoutChecklistItem.findMany({ where: { dealId, required: true } })) {
      const type = EVIDENCE[row.item]
      const evidenceDocumentId = type ? await dealDocument(db, fx, dealId, type) : null
      staff(fx.officer, "CREDIT_OFFICER")
      expect((await routes.confirm(dealId, row.item, { evidenceDocumentId, attestedSerial: deal.asset.serialNumber, note: null })).status).toBe(200)
    }
  }
  // Deal A: dual approval (the default threshold is below its amount).
  staff(fx.adminA, "LOAN_ADMIN")
  expect((await routes.createPayout(fx.dealId)).status).toBe(201)
  const pending = await routes.book(fx.dealId)
  expect(pending.status).toBe(409)
  expect((await pending.json()).error).toMatch(/must be APPROVED \(it is PENDING_APPROVAL\)/)
  staff(fx.adminB, "LOAN_ADMIN")
  expect((await routes.approve(fx.dealId)).status).toBe(200)
  // A new account approved for the supplier supersedes the one deal A's payout names.
  const account = await db.supplierBankAccount.create({
    data: {
      tenantId: fx.tenantId, supplierId: fx.supplier, bankName: "TEST Bank", branchCode: "000003", accountNumber: "0000000003",
      accountHolder: "TEST Plant Sales (Pty) Ltd", requestedById: fx.officer,
    },
  })
  await db.$transaction([
    db.supplierBankAccount.update({ where: { id: fx.accountId }, data: { status: "SUPERSEDED" } }),
    db.supplierBankAccount.update({
      where: { id: account.id },
      data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date(), avsResult: { manual: "TEST bank letter" } },
    }),
  ])
  staff(fx.adminA, "LOAN_ADMIN")
  const superseded = await routes.book(fx.dealId)
  expect(superseded.status).toBe(409)
  expect((await superseded.json()).error).toMatch(/no longer the supplier's APPROVED account/)
  // Deal B: one approver, booked.
  await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetPayoutDualApprovalCents: 500_000_000 } })
  expect((await routes.createPayout(fx.dealB)).status).toBe(201)
  expect((await routes.book(fx.dealB)).status).toBe(201)
  const booked = await db.assetFinanceDeal.findUniqueOrThrow({ where: { id: fx.dealB } })
  if (!booked.loanId) throw new Error("deal B was not booked")
  setSession(null)
  return { ...fx, loanB: booked.loanId, assetA: assets[fx.dealId], assetB: assets[fx.dealB], newAccountId: account.id }
}

function psql(script: string): { ok: boolean; output: string } {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  const result = spawnSync("psql", ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", script], { encoding: "utf8" })
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

const script = (setup: string, attempt: string, attemptWithTriggers: boolean) => `
  BEGIN;
  SET LOCAL session_replication_role = replica;
  ${setup};
  SELECT 'SETUP_DONE';
  SET LOCAL session_replication_role = ${attemptWithTriggers ? "origin" : "replica"};
  ${attempt};
  ROLLBACK;`

/**
 * The database's refusal text for `attempt` after `setup`, rolled back.
 * `triggers: false` runs the attempt with triggers off, to reach a CHECK alone.
 */
export function refusedSql(setup: string, attempt: string, { triggers = true }: { triggers?: boolean } = {}): string {
  const result = psql(script(setup, attempt, triggers))
  expect(result.output).toContain("SETUP_DONE")
  expect(result.ok, result.output).toBe(false)
  return result.output
}

/** The same transaction, expected to succeed (a positive control); rolled back. */
export function acceptedSql(setup: string, attempt: string): void {
  const result = psql(script(setup, attempt, true))
  expect(result.ok, result.output).toBe(true)
}

/** SQL that unsigns a deal's signer rows (all evidence cleared), e.g. to reopen preparation. */
export const unsignAll = (dealId: string) => `UPDATE "DealSigner" SET "method" = NULL, "signedAt" = NULL, "signatureData" = NULL,
  "signatureSha256" = NULL, "signedByIp" = NULL, "scanDocumentId" = NULL, "scanUploadedById" = NULL, "scanUploadedAt" = NULL,
  "confirmedById" = NULL, "confirmedAt" = NULL WHERE "dealId" = '${dealId}'`

/** SQL that reopens a checklist item (unconfirmed, no evidence). */
export const reopenItem = (dealId: string, item: PayoutChecklistItemKind) => `UPDATE "PayoutChecklistItem"
  SET "confirmedById" = NULL, "confirmedAt" = NULL, "evidenceDocumentId" = NULL, "attestedIdentifier" = NULL
  WHERE "dealId" = '${dealId}' AND "item" = '${item}'`

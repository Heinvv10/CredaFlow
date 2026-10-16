/**
 * What a prospect reads off the dashboard and the applications board (Fair
 * Score audit), checked on the bake's end date: PAR30 on the product's own
 * definition (lib/reports/par.ts: outstanding principal of the collectible
 * book at 30+ DPD over the whole collectible book), defaults and write-offs a
 * small minority, no open application older than 30 days, and the presenter's
 * two new-client personas not yet in the book. plan.test.ts holds the scripted
 * storylines to the same limits.
 */
import { collectibleLoanWhere, collectibleParWhere } from "../../../lib/loan/collectible-book"
import { demoLender } from "../../../prisma/demo-lender"
import { getPersona } from "../personas"
import { readDb } from "../sim/readonly-db"

/** The goal is "PAR30 at most ~15%"; the bake is held under it. */
export const PAR30_LIMIT = 0.15
/** Loans DEFAULTED, PENDING_WRITE_OFF or WRITTEN_OFF, as a share of all loans. */
export const BAD_SHARE_LIMIT = 0.2
export const PIPELINE_MAX_DAYS = 30

export interface BookFacts {
  /** Outstanding principal (cents) of the collectible book. */
  bookCents: number
  /** Outstanding principal (cents) of collectible loans at 30+ DPD. */
  par30Cents: number
  loans: number
  badLoans: number
  oldestOpenApplicationDays: number
  /** Clients holding a kit persona's ID number (must be 0: the presenter creates them). */
  kitPersonaClients: number
}

export type BookCheck = { name: string; pass: boolean; value: string }

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`

export function bookHealthChecks(f: BookFacts): BookCheck[] {
  const par30 = f.bookCents > 0 ? f.par30Cents / f.bookCents : 0
  const bad = f.loans > 0 ? f.badLoans / f.loans : 0
  return [
    { name: `PAR30 by balance <= ${pct(PAR30_LIMIT)}`, pass: par30 <= PAR30_LIMIT, value: pct(par30) },
    { name: `defaulted + written off <= ${pct(BAD_SHARE_LIMIT)} of loans`, pass: bad <= BAD_SHARE_LIMIT, value: pct(bad) },
    { name: `oldest open application <= ${PIPELINE_MAX_DAYS} days`, pass: f.oldestOpenApplicationDays <= PIPELINE_MAX_DAYS, value: `${f.oldestOpenApplicationDays} days` },
    { name: "Lerato and Mxolisi not yet clients (kit personas unused)", pass: f.kitPersonaClients === 0, value: `${f.kitPersonaClients} found` },
  ]
}

export async function readBookFacts(until: string): Promise<BookFacts> {
  const db = readDb()
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: demoLender().slug }, select: { id: true } })
  const [book, par30, loans, badLoans, apps, kit] = await Promise.all([
    db.loan.aggregate({ where: collectibleLoanWhere(tenant.id), _sum: { outstandingPrincipal: true } }),
    db.loan.aggregate({ where: collectibleParWhere(tenant.id, 30), _sum: { outstandingPrincipal: true } }),
    db.loan.count({ where: { tenantId: tenant.id } }),
    db.loan.count({ where: { tenantId: tenant.id, status: { in: ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF"] } } }),
    db.loanApplication.findFirst({
      where: { tenantId: tenant.id, status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    db.client.count({
      where: { tenantId: tenant.id, idNumber: { in: ["live-clean-approve", "live-affordability-decline"].map((id) => getPersona(id).idNumber) } },
    }),
  ])
  const oldest = apps ? Math.floor((Date.parse(`${until}T23:59:59+02:00`) - apps.createdAt.getTime()) / 86_400_000) : 0
  return {
    bookCents: Number(book._sum.outstandingPrincipal ?? 0),
    par30Cents: Number(par30._sum.outstandingPrincipal ?? 0),
    loans,
    badLoans,
    oldestOpenApplicationDays: oldest,
    kitPersonaClients: kit,
  }
}

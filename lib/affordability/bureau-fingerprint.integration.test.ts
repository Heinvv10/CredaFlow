/**
 * Run only against a disposable, fully migrated PostgreSQL database:
 *
 *   RUN_BUREAU_FINGERPRINT_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/affordability/bureau-fingerprint.integration.test.ts
 */
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import {
  bureauDecisionFingerprint,
  type BureauDecisionEvidence,
} from "@/lib/affordability/snapshot"

const suite = process.env.RUN_BUREAU_FINGERPRINT_IT === "1"
  ? describe
  : describe.skip

const baseEvidence: BureauDecisionEvidence = {
  mode: "CHECK",
  check: {
    id: "bureau-check-test",
    clientId: "client-test",
    subjectFingerprint: "a".repeat(64),
    provider: "experian",
    createdAt: "2026-04-08T08:30:00.000Z",
    score: 645,
    riskGrade: "AVERAGE RISK",
    unscoreable: false,
    hasAdverse: false,
    deceased: false,
    underDebtReview: false,
    hasJudgement: false,
    hasNotice: false,
    obligationsCents: 0,
  },
  policy: { minimumScore: 560, blockAdverse: false },
  override: null,
}

async function databaseFingerprint(evidence: BureauDecisionEvidence): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ fingerprint: string }>>(Prisma.sql`
    SELECT "bureauDecisionSha256"(${JSON.stringify(evidence)}::jsonb) AS fingerprint
  `)
  return rows[0].fingerprint
}

suite("bureau decision fingerprint database parity", () => {
  it.each([
    ["genuine", baseEvidence],
    ["simulated", {
      ...baseEvidence,
      check: { ...baseEvidence.check!, simulated: true as const },
    }],
  ])("matches TypeScript for %s bureau evidence", async (_label, evidence) => {
    await expect(databaseFingerprint(evidence)).resolves.toBe(
      bureauDecisionFingerprint(evidence),
    )
  })
})

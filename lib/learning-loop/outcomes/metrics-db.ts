import type { DecisionOutcomeKind } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { HEADLINE_BAD } from "./definition"
import { calibration, outcomeCoverage, type CalibrationCell, type CoverageCell } from "./metrics"

export type MetricsDb = Pick<typeof prisma, "decisionOutcome" | "tenantConfig">

/**
 * Coverage of one outcome kind and window (default: the headline, ever 90+
 * DPD in 12 months) and calibration of the headline, for one tenant: the
 * tenantId is in every query, as well as the caller's frame and RLS.
 * Calibration is empty until a model records a probability.
 *
 * Demo data (DESIGN.md decision 4): a real lender's figures read only rows
 * not marked demoData; a demo lender's read only its demo rows and come back
 * with `demoData: true`, for the "Simulated / demo data" label. One figure
 * never mixes the two.
 */
export async function tenantOutcomeMetrics(
  db: MetricsDb,
  tenantId: string,
  of: { outcomeKind: DecisionOutcomeKind; window: string } = HEADLINE_BAD,
): Promise<{ demoData: boolean; coverage: CoverageCell[]; calibration: CalibrationCell[] }> {
  const demoData = (await db.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }))?.isDemoLender === true
  const select = {
    decisionRecordId: true, state: true, value: true, reasonCode: true,
    decisionRecord: { select: { kind: true, decidedAt: true, modelVersion: true, predictedProbability: true } },
  } as const
  const rows = await db.decisionOutcome.findMany({ where: { tenantId, demoData, outcomeKind: of.outcomeKind, window: of.window }, select })
  const headline = of.outcomeKind === HEADLINE_BAD.outcomeKind && of.window === HEADLINE_BAD.window
    ? rows
    : await db.decisionOutcome.findMany({ where: { tenantId, demoData, ...HEADLINE_BAD }, select })
  return {
    demoData,
    coverage: outcomeCoverage(rows.map((r) => ({
      decisionRecordId: r.decisionRecordId, decisionKind: r.decisionRecord.kind, decidedAt: r.decisionRecord.decidedAt, state: r.state, reasonCode: r.reasonCode,
    }))),
    calibration: calibration(headline
      .filter((r) => r.decisionRecord.predictedProbability !== null)
      .map((r) => ({
        modelVersion: r.decisionRecord.modelVersion, decidedAt: r.decisionRecord.decidedAt,
        predictedProbability: Number(r.decisionRecord.predictedProbability), bad: r.state === "OBSERVED" ? r.value : null,
      }))),
  }
}

/**
 * Converges DecisionOutcome on what an adapter derived, per decision and
 * source system: new keys are inserted (ON CONFLICT DO NOTHING, so two
 * replicas running at once cannot collide on the unique key), changed rows
 * are updated, rows whose key the definitions no longer produce are deleted,
 * and unchanged rows are left alone. Running it twice on the same facts
 * writes nothing the second time.
 */
import type { DecisionOutcome } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { OUTCOME_DEFINITION_VERSION, type DerivedOutcome, type SourceSystem } from "./definition"

export type OutcomeWriterDb = Pick<typeof prisma, "decisionOutcome">

export interface SyncCounts { created: number; updated: number; deleted: number; unchanged: number }

const CHUNK = 200

const key = (r: Pick<DerivedOutcome, "decisionRecordId" | "outcomeKind" | "window" | "sourceRef">) =>
  `${r.decisionRecordId}|${r.outcomeKind}|${r.window}|${r.sourceRef}`

function same(row: DecisionOutcome, want: DerivedOutcome): boolean {
  return row.state === want.state && row.value === want.value && row.amountCents === want.amountCents
    && row.reasonCode === want.reasonCode && row.observedAt?.getTime() === want.observedAt?.getTime()
    && row.definitionVersion === OUTCOME_DEFINITION_VERSION
}

export async function syncOutcomes(
  db: OutcomeWriterDb,
  args: { tenantId: string; sourceSystem: SourceSystem; decisionRecordIds: readonly string[]; outcomes: readonly DerivedOutcome[]; computedAt: Date },
): Promise<SyncCounts> {
  const { tenantId, sourceSystem, computedAt } = args
  const counts: SyncCounts = { created: 0, updated: 0, deleted: 0, unchanged: 0 }
  const wanted = new Map<string, DerivedOutcome[]>()
  for (const o of args.outcomes) {
    const list = wanted.get(o.decisionRecordId)
    if (list) list.push(o)
    else wanted.set(o.decisionRecordId, [o])
  }
  const decisionIds = [...new Set([...args.decisionRecordIds, ...wanted.keys()])].sort()

  for (let i = 0; i < decisionIds.length; i += CHUNK) {
    const ids = decisionIds.slice(i, i + CHUNK)
    const existing = new Map((await db.decisionOutcome.findMany({
      where: { tenantId, sourceSystem, decisionRecordId: { in: ids } },
    })).map((row) => [key(row), row]))

    const create: DerivedOutcome[] = []
    for (const want of ids.flatMap((id) => wanted.get(id) ?? [])) {
      const row = existing.get(key(want))
      existing.delete(key(want))
      if (!row) create.push(want)
      else if (same(row, want)) counts.unchanged++
      else {
        await db.decisionOutcome.updateMany({
          where: { id: row.id, tenantId },
          data: {
            state: want.state, value: want.value, amountCents: want.amountCents, reasonCode: want.reasonCode,
            observedAt: want.observedAt, definitionVersion: OUTCOME_DEFINITION_VERSION, computedAt,
          },
        })
        counts.updated++
      }
    }
    if (create.length > 0) {
      const { count } = await db.decisionOutcome.createMany({
        data: create.map((o) => ({ ...o, tenantId, sourceSystem, definitionVersion: OUTCOME_DEFINITION_VERSION, computedAt })),
        skipDuplicates: true,
      })
      counts.created += count
    }
    const stale = [...existing.values()].map((row) => row.id)
    if (stale.length > 0) {
      counts.deleted += (await db.decisionOutcome.deleteMany({ where: { tenantId, id: { in: stale } } })).count
    }
  }
  return counts
}

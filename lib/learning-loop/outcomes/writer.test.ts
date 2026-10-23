// The writer's convergence logic over an in-memory table. The real unique key,
// ON CONFLICT and RLS are proven in outcomes.integration.test.ts.
import type { DecisionOutcome } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { OUTCOME_DEFINITION_VERSION, type DerivedOutcome } from "./definition"
import { syncOutcomes, type OutcomeWriterDb } from "./writer"

type Where = { tenantId: string; sourceSystem?: string; decisionRecordId?: { in: string[] }; id?: string | { in: string[] } }

function memoryDb() {
  const rows: DecisionOutcome[] = []
  let seq = 0
  const match = (r: DecisionOutcome, w: Where) => r.tenantId === w.tenantId
    && (w.sourceSystem === undefined || r.sourceSystem === w.sourceSystem)
    && (w.decisionRecordId === undefined || w.decisionRecordId.in.includes(r.decisionRecordId))
    && (w.id === undefined || (typeof w.id === "string" ? r.id === w.id : w.id.in.includes(r.id)))
  const db = {
    decisionOutcome: {
      findMany: async ({ where }: { where: Where }) => rows.filter((r) => match(r, where)).map((r) => ({ ...r })),
      createMany: async ({ data }: { data: Omit<DecisionOutcome, "id">[] }) => {
        let count = 0
        for (const d of data) {
          if (rows.some((r) => r.decisionRecordId === d.decisionRecordId && r.outcomeKind === d.outcomeKind && r.window === d.window && r.sourceSystem === d.sourceSystem && r.sourceRef === d.sourceRef)) continue
          rows.push({ ...d, id: `row-${++seq}` })
          count++
        }
        return { count }
      },
      updateMany: async ({ where, data }: { where: Where; data: Partial<DecisionOutcome> }) => {
        const hit = rows.filter((r) => match(r, where))
        for (const r of hit) Object.assign(r, data)
        return { count: hit.length }
      },
      deleteMany: async ({ where }: { where: Where }) => {
        const before = rows.length
        for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], where)) rows.splice(i, 1)
        return { count: before - rows.length }
      },
    },
  }
  return { rows, db: db as unknown as OutcomeWriterDb }
}

const outcome = (over: Partial<DerivedOutcome> = {}): DerivedOutcome => ({
  decisionRecordId: "dec-1", outcomeKind: "EVER_90_DPD", window: "12M", state: "PENDING", value: null,
  amountCents: null, reasonCode: null, sourceRef: "loan-1", observedAt: null, ...over,
})
const run = (db: OutcomeWriterDb, outcomes: DerivedOutcome[], decisionRecordIds = ["dec-1"], computedAt = new Date("2026-10-21T00:30:00+02:00"), demoData = false) =>
  syncOutcomes(db, { tenantId: "t-1", sourceSystem: "credaflow", decisionRecordIds, outcomes, computedAt, demoData })

describe("syncOutcomes", () => {
  it("inserts, then a second run with the same facts writes nothing", async () => {
    const { db, rows } = memoryDb()
    expect(await run(db, [outcome(), outcome({ outcomeKind: "SETTLED" })])).toEqual({ created: 2, updated: 0, deleted: 0, unchanged: 0 })
    const first = rows.map((r) => ({ ...r }))
    expect(await run(db, [outcome(), outcome({ outcomeKind: "SETTLED" })], ["dec-1"], new Date("2026-10-22T00:30:00+02:00")))
      .toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 2 })
    expect(rows).toEqual(first)
    expect(rows.every((r) => r.tenantId === "t-1" && r.sourceSystem === "credaflow" && r.definitionVersion === OUTCOME_DEFINITION_VERSION)).toBe(true)
  })

  it("updates a row whose window matured, keeping its id", async () => {
    const { db, rows } = memoryDb()
    await run(db, [outcome()])
    const id = rows[0].id
    const observedAt = new Date("2026-05-29T00:00:00+02:00")
    const later = new Date("2027-02-01T00:30:00+02:00")
    expect(await run(db, [outcome({ state: "OBSERVED", value: true, observedAt })], ["dec-1"], later)).toMatchObject({ updated: 1 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id, state: "OBSERVED", value: true, observedAt, computedAt: later })
  })

  it("removes rows the definitions no longer produce for an evaluated decision", async () => {
    const { db, rows } = memoryDb()
    await run(db, [outcome(), outcome({ outcomeKind: "SETTLED" })])
    expect(await run(db, [outcome()])).toMatchObject({ deleted: 1, unchanged: 1 })
    expect(rows.map((r) => r.outcomeKind)).toEqual(["EVER_90_DPD"])
  })

  it("removes the rows of a decision no longer attributed, but keeps a failed decision's rows", async () => {
    const { db, rows } = memoryDb()
    await run(db, [outcome(), outcome({ decisionRecordId: "dec-2" }), outcome({ decisionRecordId: "dec-3" })], ["dec-1", "dec-2", "dec-3"])
    const counts = await syncOutcomes(db, {
      tenantId: "t-1", sourceSystem: "credaflow", decisionRecordIds: ["dec-1"], outcomes: [outcome()],
      computedAt: new Date("2026-10-22T00:30:00+02:00"), keepDecisionRecordIds: ["dec-3"], demoData: false,
    })
    expect(counts).toMatchObject({ deleted: 1, unchanged: 1 })
    expect(rows.map((r) => r.decisionRecordId).sort()).toEqual(["dec-1", "dec-3"])
  })

  it("leaves every row alone when the run attributes no decision at all", async () => {
    const { db, rows } = memoryDb()
    await run(db, [outcome(), outcome({ decisionRecordId: "dec-2" })], ["dec-1", "dec-2"])
    expect(await run(db, [], [])).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 0 })
    expect(rows.map((r) => r.decisionRecordId).sort()).toEqual(["dec-1", "dec-2"])
  })

  it("marks a demo lender's rows demoData, and re-marks a row whose lender's flag changed", async () => {
    const { db, rows } = memoryDb()
    await run(db, [outcome()], ["dec-1"], undefined, true)
    expect(rows.map((r) => r.demoData)).toEqual([true])
    expect(await run(db, [outcome()], ["dec-1"], undefined, false)).toMatchObject({ updated: 1, unchanged: 0 })
    expect(rows.map((r) => r.demoData)).toEqual([false])
  })

  it("keeps a take-up's first observed time when only the time moved", async () => {
    const { db, rows } = memoryDb()
    const first = new Date("2026-03-01T10:00:00+02:00")
    const takeUp = (observedAt: Date) => outcome({ outcomeKind: "TAKEN_UP", window: "OFFER", state: "OBSERVED", value: false, observedAt })
    await run(db, [takeUp(first)])
    expect(await run(db, [takeUp(new Date("2026-04-01T10:00:00+02:00"))])).toMatchObject({ unchanged: 1, updated: 0 })
    expect(rows[0].observedAt).toEqual(first)
  })
})

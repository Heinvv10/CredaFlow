/**
 * Real-Postgres proof that one person cannot lift the NCA interest cap by
 * rejecting a repo cut the SARB feed recorded: the rejected cut keeps the cap
 * down (lib/loan/nca-interest-cap.server.ts capRepoRate) until a later value is
 * approved, and a MANUAL value needs a second person to approve it (CHECK
 * ReferenceRate_four_eyes).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/nca-repo-cap.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { decideReferenceRate } from "@/lib/asset-finance/reference-rate-decision"
import { capRepoRate } from "./nca-interest-cap.server"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_repo_cap_${t}`
const ids = { adminA: "", adminB: "" }
const day = "2026-10-16"

const decide = (rateId: string, deciderId: string, decision: "APPROVE" | "REJECT") =>
  db.$transaction((tx) => decideReferenceRate(tx as never, { tenantId, rateId, decision, deciderId, today: day }))

suite.sequential("a rejected SARB repo cut keeps the NCA cap down (real Postgres)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `repo-cap-${t}`, name: "Repo cap IT" } })
    const user = (label: string) => db.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })
    ids.adminA = (await user("admin-a")).id
    ids.adminB = (await user("admin-b")).id
    const approved = await db.referenceRate.create({
      data: { tenantId, basis: "REPO", effectiveDate: new Date("2026-05-29"), rate: "0.0725", source: "MANUAL", requestedById: ids.adminA },
    })
    expect(await decide(approved.id, ids.adminB, "APPROVE")).toMatchObject({ kind: "decided" })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it("one person rejecting a lower fed value does not restore the higher cap", async () => {
    const cut = await db.referenceRate.create({
      data: { tenantId, basis: "REPO", effectiveDate: new Date("2026-09-18"), rate: "0.07", source: "SARB_FEED" },
    })
    expect(await capRepoRate(db as never, tenantId, day)).toEqual({ rate: 0.07, approved: 0.0725 })
    expect(await decide(cut.id, ids.adminA, "REJECT")).toMatchObject({ kind: "decided", rate: { status: "REJECTED" } })
    expect(await capRepoRate(db as never, tenantId, day)).toEqual({ rate: 0.07, approved: 0.0725 })
  })

  it("a later MANUAL value displaces it only once a second person approves it", async () => {
    const manual = await db.referenceRate.create({
      data: { tenantId, basis: "REPO", effectiveDate: new Date("2026-09-19"), rate: "0.0725", source: "MANUAL", requestedById: ids.adminA },
    })
    expect(await capRepoRate(db as never, tenantId, day)).toEqual({ rate: 0.07, approved: 0.0725 })
    expect(await decide(manual.id, ids.adminA, "APPROVE")).toEqual({ kind: "self_decision" })
    expect(await capRepoRate(db as never, tenantId, day)).toEqual({ rate: 0.07, approved: 0.0725 })
    expect(await decide(manual.id, ids.adminB, "APPROVE")).toMatchObject({ kind: "decided" })
    expect(await capRepoRate(db as never, tenantId, day)).toEqual({ rate: 0.0725, approved: 0.0725 })
  })
})

import { NextRequest } from "next/server"
import { describe, expect, it, vi } from "vitest"

const seen = vi.hoisted(() => ({ loanKeys: [] as string[], recoveryKeys: [] as string[] }))
const controls = Array.from({ length: 60 }, (_, i) => ({ control: "AF_INPUT_VAT", key: `k${i}`, journalCents: 1, bookCents: 2 }))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ user: { id: "u-1" } })) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, run: (t: { id: string }) => unknown) => run({ id: "t-1" }) }))
vi.mock("@/lib/accounting/plan", () => ({
  planPeriod: vi.fn(async () => ({
    isGoLive: false, entries: [], controls, refusal: null, reconciliation: { journalTotalCents: 0, bookTotalCents: 0, mismatches: [] },
  })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    accountingExportBatch: { findFirst: vi.fn(async () => null) },
    loan: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => { seen.loanKeys = args.where.id.in; return [{ id: "k0", reference: "AF-0" }] }) },
    recovery: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => { seen.recoveryKeys = args.where.id.in; return [] }) },
  },
}))

import { GET } from "./route"

describe("accounting preview", () => {
  it("resolves references only for the controls it returns (the first 50)", async () => {
    const res = await GET(new NextRequest("http://x.invalid/api/accounting/preview?period=2026-09"))
    const json = (await res.json()) as { controls: Array<{ key: string; reference: string | null }> }
    expect(json.controls).toHaveLength(50)
    expect(seen.loanKeys).toHaveLength(50)
    expect(seen.recoveryKeys).toHaveLength(50)
    expect(seen.loanKeys).not.toContain("k50")
    expect(json.controls[0]).toMatchObject({ key: "k0", reference: "AF-0" })
    expect(json.controls[1].reference).toBeNull()
  })
})

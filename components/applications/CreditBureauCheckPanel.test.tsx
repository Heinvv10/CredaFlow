import { renderToStaticMarkup } from "react-dom/server"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { CreditBureauCheckPanel } from "./CreditBureauCheckPanel"
import { resolveBureauDisplay } from "@/lib/compliance/bureau-display"

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

const approvalSnapshot = {
  stage: "APPROVAL" as const,
  bureauEvidence: {
    mode: "CHECK" as const,
    check: {
      id: "bureau-check-legacy",
      clientId: "client-1",
      subjectFingerprint: "a".repeat(64),
      provider: "TransUnion",
      createdAt: "2026-07-18T08:30:00.000Z",
      score: 612,
      riskGrade: "B",
      unscoreable: false,
      hasAdverse: true,
      deceased: false,
      underDebtReview: false,
      hasJudgement: true,
      hasNotice: false,
      obligationsCents: 125_000,
    },
    policy: { minimumScore: 500, blockAdverse: true },
    override: null,
  },
}

describe("CreditBureauCheckPanel immutable approval evidence", () => {
  it("renders the approval snapshot when a migrated legacy decision has no compliance record", () => {
    const display = resolveBureauDisplay({
      applicationStatus: "APPROVED",
      approvalSnapshot,
      complianceRecord: null,
    })
    const html = renderToStaticMarkup(
      <CreditBureauCheckPanel
        display={display}
        bureauDebt={125_000}
        selfDeclaredDebt={100_000}
      />,
    )

    expect(html).toContain("immutable approval snapshot")
    expect(html).toContain("TransUnion")
    expect(html).toContain(">612<")
    expect(html).toContain(">B<")
    expect(html).toContain("Judgement recorded")
    expect(html).not.toContain("No bureau check recorded")
  })

  it("fails closed instead of substituting a stale compliance record", () => {
    const display = resolveBureauDisplay({
      applicationStatus: "DISBURSED",
      approvalSnapshot: null,
      complianceRecord: {
        status: "COMPLETED",
        data: { provider: "stale-provider", score: 700 },
        createdAt: new Date("2026-07-17T08:30:00.000Z"),
        completedAt: null,
      },
    })
    const html = renderToStaticMarkup(
      <CreditBureauCheckPanel display={display} bureauDebt={null} selfDeclaredDebt={0} />,
    )

    expect(html).toContain("Immutable bureau decision evidence is missing")
    expect(html).not.toContain("stale-provider")
    expect(html).not.toContain(">700<")
  })

  it("renders both the sealed bureau result and the audited override", () => {
    const overrideReason = "Senior approved exception"
    const display = resolveBureauDisplay({
      applicationStatus: "APPROVED",
      approvalSnapshot: {
        ...approvalSnapshot,
        bureauEvidence: {
          ...approvalSnapshot.bureauEvidence,
          mode: "OVERRIDE",
          check: {
            ...approvalSnapshot.bureauEvidence.check,
            score: 312,
            riskGrade: "D",
            underDebtReview: true,
            hasJudgement: true,
            obligationsCents: 250_000,
          },
          override: {
            reason: overrideReason,
            reasonSha256: sha256Text(overrideReason),
            byId: "senior-1",
            at: "2026-07-18T09:00:00.000Z",
          },
        },
      },
      complianceRecord: {
        status: "COMPLETED",
        data: { provider: "mutable-provider", score: 800 },
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        completedAt: null,
      },
    })
    const html = renderToStaticMarkup(
      <CreditBureauCheckPanel
        display={display}
        bureauDebt={250_000}
        selfDeclaredDebt={100_000}
      />,
    )

    expect(html).toContain("Senior approved exception")
    expect(html).toContain("senior-1")
    expect(html).toContain("TransUnion")
    expect(html).toContain(">312<")
    expect(html).toContain(">D<")
    expect(html).toContain("Consumer under debt review")
    expect(html).toContain("Judgement recorded")
    expect(html).toContain("R 2,500.00")
    expect(html).not.toContain("mutable-provider")
    expect(html).not.toContain(">800<")
  })

  it("renders an override with no check without substituting mutable bureau data", () => {
    const overrideReason = "Approved after documented no-hit review"
    const display = resolveBureauDisplay({
      applicationStatus: "DISBURSED",
      approvalSnapshot: {
        stage: "APPROVAL",
        bureauEvidence: {
          mode: "OVERRIDE",
          check: null,
          policy: { minimumScore: 500, blockAdverse: true },
          override: {
            reason: overrideReason,
            reasonSha256: sha256Text(overrideReason),
            byId: "senior-2",
            at: "2026-07-18T09:30:00.000Z",
          },
        },
      },
      complianceRecord: {
        status: "COMPLETED",
        data: { provider: "stale-provider", score: 799 },
        createdAt: new Date("2026-07-18T10:00:00.000Z"),
        completedAt: null,
      },
    })
    const html = renderToStaticMarkup(
      <CreditBureauCheckPanel display={display} bureauDebt={0} selfDeclaredDebt={0} />,
    )

    expect(html).toContain("Approved after documented no-hit review")
    expect(html).toContain("senior-2")
    expect(html).not.toContain("stale-provider")
    expect(html).not.toContain(">799<")
  })
})

describe("CreditBureauCheckPanel simulated result", () => {
  const record = (data: Record<string, unknown>) => ({
    status: "COMPLETED",
    data: { provider: "experian", score: 645, ...data },
    createdAt: new Date("2026-07-18T08:30:00.000Z"),
    completedAt: new Date("2026-07-18T08:30:00.000Z"),
  })
  const render = (data: Record<string, unknown>) =>
    renderToStaticMarkup(
      <CreditBureauCheckPanel
        display={resolveBureauDisplay({
          applicationStatus: "UNDER_REVIEW",
          approvalSnapshot: null,
          complianceRecord: record(data),
        })}
        bureauDebt={null}
        selfDeclaredDebt={0}
      />,
    )

  it("labels a simulated check as not a real bureau result", () => {
    expect(render({ simulated: true })).toContain("Simulated result \u2014 not a real bureau check")
  })

  it("does not label a genuine check", () => {
    expect(render({})).not.toContain("Simulated")
  })
})

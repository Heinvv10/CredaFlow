import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// Every writer that creates a LoanApplication or moves one to SUBMITTED, and what stops it on a key-facts instance.
// Reads the source: a new channel fails here until someone says which applies, the gate or a refusal (pre-submission.ts).
const CHANNELS: Record<string, string> = {
  // The gate: a statement shown for exactly these terms.
  "app/api/portal/applications/route.ts": "indicativeKeyFactsShown(tx",
  "app/api/applications/[id]/route.ts": "indicativeKeyFactsShown(tx",
  // Staff capture saves a draft, and the page above submits it.
  "app/api/applications/route.ts": `data.submitForReview && newApplicationRegime() === "KEY_FACTS"`,
  // Refused: no statement step.
  "app/api/website/apply/route.ts": `if (newApplicationRegime() === "KEY_FACTS") {`,
  "app/api/crm/leads/[id]/convert/route.ts": `if (newApplicationRegime() === "KEY_FACTS") return`,
  "lib/asset-finance/deal-create.ts": `if (newApplicationRegime() === "KEY_FACTS") return refused(409`,
  "lib/asset-finance/deal-submit.ts": `if (deal.application.disclosureRegime === "KEY_FACTS") return`,
  // The API makes drafts only; a draft goes through the staff gate.
  "lib/lender-api/create-application.ts": "submitForReview: false",
  // A loan change's new loan opens UNDER_REVIEW behind the borrower's signed variation; the database's document gate skips it by its request.
  "lib/loan-changes/approval.ts": "loanChangeRequestId: request.id",
}

const IGNORED = /(\.test\.tsx?|\.it-helpers\.ts|fixture\.ts|\.test-helpers\.ts)$/
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return /\.tsx?$/.test(name) && !IGNORED.test(name) ? [full] : []
  })
}
const WRITER = /loanApplication\.create\(|loanApplication\.(?:update|updateMany)\(\{[\s\S]{0,900}?status: "SUBMITTED"/

describe("every channel that can make a submitted application on a key-facts instance", () => {
  it("is in the census", () => {
    const writers = [...sources("app"), ...sources("lib")].filter((file) => WRITER.test(readFileSync(file, "utf8"))).filter((file) => !file.startsWith("lib/non-nca-documents"))
    expect(writers.sort()).toEqual(Object.keys(CHANNELS).sort())
  })

  it.each(Object.entries(CHANNELS))("%s applies the gate or refuses", (file, proof) => {
    expect(readFileSync(file, "utf8")).toContain(proof)
  })
})

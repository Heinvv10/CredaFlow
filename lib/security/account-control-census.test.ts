/**
 * The inventory of two-person controls: each must apply the shared rule (./account-control.ts). A new four-eyes constraint in the database
 * fails this until the control behind it is added here, with the rule. What it does at run time is proved in
 * account-control-wiring.test.ts, lib/approval/approval-sockpuppet.integration.test.ts and the suites of the control.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/** Each control's approving act, the file holding it, and the database object that holds its plain "not the same person" rule, if one does. */
const CONTROLS: ReadonlyArray<{ control: string; file: string; constraint?: string }> = [
  { control: "maker-checker: decision rules, engine settings, approval matrix, product versions, pricing (ChangeRequest)", file: "lib/maker-checker/service.ts", constraint: "ChangeRequest_four_eyes" },
  { control: "approval matrix chain (ApprovalStep, levels)", file: "lib/approval/assess.ts" },
  { control: "credit committee recorder", file: "lib/approval/committee.ts" },
  { control: "clearing a committee condition", file: "lib/approval/conditions.ts" },
  { control: "disbursing an approved application (segregation of duties)", file: "app/api/applications/[id]/disburse/route.ts" },
  { control: "paying out a key-facts loan (segregation of duties, and against whoever confirmed the account)", file: "lib/non-nca-documents/payout-gates.ts" },
  { control: "confirming a key-facts payout account", file: "lib/non-nca-documents/payout-account.ts" },
  { control: "countersigning an in-branch signature (segregation of duties)", file: "app/api/applications/[id]/agreement/countersign/route.ts" },
  { control: "document template approval", file: "app/api/documents/templates/[id]/versions/[versionId]/approve/route.ts" },
  { control: "lender legal template approval and publishing", file: "lib/asset-finance/documents/templates/store.ts" },
  { control: "valuation guide publishing", file: "lib/valuation-guides/guide-store.ts", constraint: "ValuationGuide_four_eyes" },
  { control: "reference and repo rates", file: "lib/asset-finance/reference-rate-decision.ts", constraint: "ReferenceRate_four_eyes" },
  { control: "NCA regime override", file: "app/api/asset-finance/nca-overrides/[overrideId]/decide/route.ts", constraint: "NcaRegimeOverride_four_eyes" },
  { control: "KYC override request", file: "app/api/clients/[id]/kyc-override-requests/[requestId]/route.ts", constraint: "KycOverrideRequest_different_decider_check" },
  { control: "screening match review", file: "lib/screening/review.ts", constraint: "ScreeningCheck_maker_checker" },
  { control: "RMCP version approval", file: "app/api/compliance/fic/rmcp/[id]/route.ts", constraint: "RmcpDocument_maker_checker" },
  { control: "suspicious report decision", file: "app/api/compliance/fic/str/[id]/route.ts", constraint: "SuspiciousReportCase_maker_checker" },
  { control: "loan write-off", file: "app/api/loans/[id]/write-off/route.ts" },
  { control: "payout retry", file: "lib/payouts/retry.ts" },
  { control: "disbursement reversal", file: "lib/payouts/reversal.ts" },
  { control: "confirming a payout's outcome", file: "lib/payouts/resolve.ts" },
  { control: "resolving a provider conflict", file: "lib/payouts/conflicts.ts" },
  { control: "asset-finance payout", file: "lib/asset-finance/payout.ts", constraint: "Payout_four_eyes" },
  { control: "wet-ink scan confirmation", file: "lib/asset-finance/signing-wet-ink.ts", constraint: "DealSigner_wet_ink_four_eyes" },
  { control: "supplier bank account", file: "lib/asset-finance/supplier-bank-decision.ts", constraint: "SupplierBankAccount_four_eyes" },
  { control: "dealer bank account", file: "lib/dealer/staff-bank-accounts.ts", constraint: "DealerBankAccount_four_eyes" },
  { control: "dealer payable run", file: "lib/dealer/payable-runs.ts", constraint: "DealerPayableRun_four_eyes" },
  { control: "maintenance claim", file: "lib/asset-finance/maintenance-claims.ts", constraint: "MaintenanceClaim_four_eyes" },
  { control: "meter reading void", file: "lib/asset-finance/meter-void.ts", constraint: "AssetMeterReadingVoid_four_eyes" },
  { control: "theft report confirmation", file: "lib/telematics/theft-reports.ts" },
  { control: "recovery cost", file: "lib/asset-finance/recovery-costs.ts" },
  { control: "remarketing sale", file: "lib/asset-finance/recovery-sale.ts" },
  { control: "recovery refund approval and release", file: "lib/asset-finance/recovery-refund.ts" },
  { control: "NCA surplus account", file: "lib/asset-finance/nca-surplus-account.ts" },
  { control: "billing inspection damage", file: "lib/asset-finance/lease-end-billing.ts" },
  { control: "valuation behind a lease purchase", file: "lib/asset-finance/lease-term-end.ts" },
]

/** A constraint the census has looked at that needs no rule of its own: not a decision by a second person, or a decision named above by another route. */
const NOT_CONTROLS = new Set<string>([])

describe("the inventory of two-person controls", () => {
  it.each(CONTROLS)("$control applies the two-people rule", ({ file }) => {
    expect(readFileSync(join(process.cwd(), file), "utf8")).toMatch(/accountControlRefusal\(|requireTwoPeople\(|refuseControlledMaker\(/)
  })

  it("every four-eyes constraint in the database is a control in this inventory", () => {
    const root = join(process.cwd(), "prisma/migrations")
    const named = new Set<string>()
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const sql = readFileSync(join(root, dir.name, "migration.sql"), "utf8")
      for (const match of sql.matchAll(/ADD CONSTRAINT "([A-Za-z_]*(?:four_eyes|maker_checker|different_decider)[A-Za-z_]*)"/g)) named.add(match[1])
    }
    const inventoried = new Set(CONTROLS.flatMap((c) => (c.constraint ? [c.constraint] : [])))
    expect([...named].filter((name) => !inventoried.has(name) && !NOT_CONTROLS.has(name))).toEqual([])
    expect([...inventoried].filter((name) => !named.has(name))).toEqual([])
  })
})

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
  { control: "maker-checker: every change handler below (ChangeRequest)", file: "lib/maker-checker/service.ts", constraint: "ChangeRequest_four_eyes" },
  { control: "approval matrix chain (ApprovalStep, levels)", file: "lib/approval/assess.ts" },
  { control: "credit committee recorder", file: "lib/approval/committee.ts" },
  { control: "clearing a committee condition", file: "lib/approval/conditions.ts" },
  { control: "disbursing an approved application (segregation of duties)", file: "app/api/applications/[id]/disburse/route.ts" },
  { control: "paying out a key-facts loan (segregation of duties, and against whoever confirmed the account)", file: "lib/non-nca-documents/payout-gates.ts" },
  { control: "confirming a key-facts payout account (the shared list of the people behind the payout)", file: "lib/non-nca-documents/payout-people.ts" },
  { control: "confirming an address staff set for a borrower (signing codes and login recovery)", file: "lib/contact/identity-confirmation.ts" },
  { control: "countersigning an in-branch signature (segregation of duties)", file: "app/api/applications/[id]/agreement/countersign/route.ts" },
  { control: "document template approval", file: "app/api/documents/templates/[id]/versions/[versionId]/approve/route.ts" },
  { control: "document template publishing", file: "app/api/documents/templates/[id]/versions/[versionId]/publish/route.ts" },
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
  { control: "payout recovery case: escalating and closing it", file: "lib/payouts/recovery.ts" },
  { control: "acknowledging an unapplied provider report", file: "lib/payouts/unapplied-reports.ts" },
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

/** Every kind maker-checker approves, each under the rule: DECISION_ENGINE_CONFIG carries the F7 instant key-facts setting, LOAN_CHANGE the A3 loan changes. */
const CHANGE_KINDS = ["APPROVAL_MATRIX", "DECISION_ENGINE_CONFIG", "DECISION_RULE_SET", "LOAN_CHANGE", "PRODUCT_PRICING_RULE", "PRODUCT_VERSION"]

/** A constraint the census has looked at that needs no rule of its own: not a decision by a second person, or a decision named above by another route. */
const NOT_CONTROLS = new Set<string>([])

/**
 * Every pair of "who" columns a migration compares, sorted: a control held only by a trigger shows here. Each pair is a control above, or says
 * why it is none. A new pair fails until it is placed.
 */
const COMPARED_COLUMNS: Readonly<Record<string, string>> = {
  "acknowledgedById/createdById": "acknowledging an unapplied provider report",
  "acknowledgedById/disbursedById": "acknowledging an unapplied provider report",
  "acknowledgedById/escalatedById": "acknowledging an unapplied provider report",
  "acknowledgedById/openedById": "acknowledging an unapplied provider report",
  "acknowledgedById/requestedById": "acknowledging an unapplied provider report",
  "activatedById/approvedById": "lender legal template publishing",
  "agreementCountersignedById/agreementSignedByUserId": "countersigning",
  "agreementSignedByUserId/disbursedById": "paying out a key-facts loan: the witness of a branch signature does not pay it",
  "approvedById/clearedById": "clearing a committee condition, asset-finance payout",
  "approvedById/conflictResolvedById": "resolving a provider conflict",
  "approvedById/releaseAuthorisedById": "NCA surplus account",
  "bureauOverrideById/disbursedById": "disbursing: the engine's attesters",
  "clearedById/createdById": "clearing a committee condition, asset-finance payout",
  "clearedById/releasedById": "clearing a committee condition, asset-finance payout",
  "conflictResolvedById/createdById": "resolving a provider conflict",
  "conflictResolvedById/disbursedById": "resolving a provider conflict",
  "createdById/releaseAuthorisedById": "NCA surplus account",
  "createdById/returnedById": "confirming a payout's outcome",
  "disbursedById/incomeVerifiedById": "disbursing: the engine's attesters",
  "disbursedById/recklessLendingAssessedById": "disbursing: the engine's attesters",
  "disbursedById/returnedById": "confirming a payout's outcome",
  "approvedById/createdById": "asset-finance payout, recovery refund, dealer payable run",
  "approvedById/disbursedById": "disbursing, payout retry",
  "approvedById/firstApprovedById": "maintenance claim",
  "approvedById/recordedById": "recovery cost",
  "approvedById/releasedById": "recovery refund release",
  "approvedById/requestedById": "payout retry",
  "approvedById/resolvedById": "confirming a payout's outcome",
  "approvedById/returnedById": "confirming a payout's outcome",
  "approvedById/submittedById": "maintenance claim",
  "approvedById/uploadedById": "RMCP version approval",
  "assessedById/raisedById": "suspicious report decision",
  "clearedById/disbursedById": "clearing a committee condition",
  "confirmedById/recordedById": "theft report confirmation",
  "confirmedByUserId/setByStaffUserId": "confirming an address staff set for a borrower",
  "conflictResolvedById/openedById": "payout recovery case: opened by the conflict's resolver, a provenance check",
  "createdById/dealerUserId": "not a control: provenance of a dealer's own row",
  "createdById/disbursedById": "confirming a payout's outcome, payout retry",
  "createdById/releasedById": "recovery refund release",
  "createdById/requestedById": "not a control: a payout attempt names its requester as its creator",
  "createdById/resolvedById": "confirming a payout's outcome",
  "decidedById/recordedById": "not a control: a held telematics reading's meter row names its decider",
  "decidedById/requestedById": "reference rates, bank accounts, overrides, meter voids",
  "disbursedById/resolvedById": "confirming a payout's outcome",
  "executedById/uploadedById": "not a control: the executor's own evidence document",
  "firstApprovedById/submittedById": "maintenance claim",
  "publishedById/uploadedById": "valuation guide publishing",
  "recordedById/uploadedById": "not a control: the recorder's own evidence document",
  "reviewedById/triggeredById": "screening match review",
  "scanUploadedById/uploadedById": "not a control: the uploader's own scan document",
}

describe("the inventory of two-person controls", () => {
  it("every change handler is one of the kinds this inventory has placed", () => {
    const root = join(process.cwd(), "lib/registry/change-handlers")
    const kinds = readdirSync(root).flatMap((file) => [...readFileSync(join(root, file), "utf8").matchAll(/kind: "([A-Z_]+)"/g)].map((m) => m[1]))
    expect(kinds.sort()).toEqual(CHANGE_KINDS)
  })

  it("every pair of people a migration compares is a control in this inventory, or says why not", () => {
    const root = join(process.cwd(), "prisma/migrations")
    const seen = new Set<string>()
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const sql = readFileSync(join(root, dir.name, "migration.sql"), "utf8")
      for (const m of sql.matchAll(/"(\w+(?:ById|UserId))"\)?\s*(?:=|<>|IS NOT DISTINCT FROM|IS DISTINCT FROM)\s*(?:lower\(btrim\()?(?:NEW|OLD|[a-z])?\.?"(\w+(?:ById|UserId))"/g)) {
        if (m[1] !== m[2]) seen.add([m[1], m[2]].sort().join("/"))
      }
      for (const m of sql.matchAll(/"(\w+(?:ById|UserId))"\)?\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/g)) {
        for (const other of m[2].matchAll(/"(\w+(?:ById|UserId))"/g)) if (m[1] !== other[1]) seen.add([m[1], other[1]].sort().join("/"))
      }
    }
    expect([...seen].filter((pair) => !(pair in COMPARED_COLUMNS)).sort()).toEqual([])
  })

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

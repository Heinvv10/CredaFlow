import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import {
  applicationApprovedEmail,
  applicationDeclinedEmail,
  applicationSubmittedEmail,
  paymentDueReminderEmail,
  paymentReceivedEmail,
} from "./portal"
import { disbursedHtml, overdueHtml } from "./loan-events"

/**
 * The borrower emails were moved onto the comms catalogue (lib/i18n) so they
 * can go out in the client's language. English must come out byte-identical
 * to what borrowers received before: these digests were taken from the
 * pre-catalogue templates (W7, 2026-10-14). Re-pin only with a proof of what
 * changed in the English wording.
 */
const identity = parseLenderIdentity(VALID_LENDER_COLUMNS)
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

const RENDERS: Record<string, () => string> = {
  submitted: () => applicationSubmittedEmail(identity, "Thandi Mthembu", "APP-0001", "Personal loan", 500_000, "https://portal.lender.example/portal/continue?x=1"),
  submittedNoPortal: () => applicationSubmittedEmail(identity, "Thandi Mthembu", "APP-0001", "Personal loan", 500_000),
  approved: () => applicationApprovedEmail(identity, "Thandi Mthembu", "APP-0001", "Personal loan", 450_000, "https://app.lender.example/portal"),
  declined: () => applicationDeclinedEmail(identity, "Thandi Mthembu", "APP-0001", "Affordability"),
  dueReminder: () => paymentDueReminderEmail(identity, "Thandi Mthembu", 150_000, "2026-10-01", "LN-0001"),
  received: () => paymentReceivedEmail(identity, "Thandi Mthembu", 150_000, "LN-0001", 900_000),
  disbursed: () => disbursedHtml(identity, "Thandi Mthembu", "LN-0001"),
  overdue: () => overdueHtml(identity, "Thandi Mthembu", 7, "LN-0001"),
  overdueNoDaysNoRef: () => overdueHtml(identity, "Thandi Mthembu", 0, ""),
}

const PINNED: Record<string, string> = {
  submitted: "06e336f82a563714f67899d36ec941e4c957475369125e524dc4022206268a9b",
  submittedNoPortal: "17f88ed8e0f544a16f7a219e7b5b7176774f85a9a1ec1738ba127c3c72f2bddb",
  approved: "4843b335422a39a4454c54b52b4ef0f7d79e0061933cdc9a79268a0badf9e167",
  declined: "465c857a1f2d14f20286cdbfad9793482ac03aafbfd047ab5b0d6d59eaf7b926",
  // Re-pinned 2026-10-16 (Fair Score audit B5): the only change is the sentence
  // "To avoid further default interest and charges, please ensure payment is
  // made by the due date." → "Please make your payment by the due date." —
  // swapping it back reproduces the previous digest 999365…4889.
  dueReminder: "f4ae0f0441f0210dadcca4d91637f9462a477633cc6e77d5670db03101182f68",
  received: "cc554275f8d30e42d54cf6d593a52774da61ce13629dfae902014c15fac01b90",
  disbursed: "be33b6ad920453419067e2a0dc7b592b09b4cf320ea373029ed9438d1b454ab2",
  overdue: "e317b90ca9af94cea58e4ca0377dbdc06d9ed394d09122fb7119807b258e4179",
  overdueNoDaysNoRef: "5a23894be39dd19ef8ca82580f49e0a1810dd6d4d96e95537d5b31ffc4bebe58",
}

describe("English borrower emails are unchanged by the catalogue move", () => {
  it.each(Object.keys(RENDERS))("%s", (name) => {
    expect({ name, sha: sha(RENDERS[name]()) }).toEqual({ name, sha: PINNED[name] })
  })
})

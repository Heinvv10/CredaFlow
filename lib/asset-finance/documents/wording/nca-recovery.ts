// Clause wording for the s131 repossessed-goods notices
// (../nca/recovery-pdf.ts). Section 131 applies sections 127(2) to (9) and 128
// to goods attached under a court order. DRAFT for the lender's legal team
// (the rules behind it are signed off: see DESIGN.md sign-off record 2026-10-17); sources and open points:
// docs/asset-finance/legal-wording/nca.md; code gaps: docs/asset-finance/legal-wording/README.md.
import { formatZarPdf } from "@/lib/pdf/helpers"
import type { RecoveryNoticeData } from "../nca/recovery-pdf"
import { formatIsoDatePdf } from "../pdf-layout"
import type { NcaClause } from "./nca-agreement"
import { SHORTFALL_FREEZE, SURPLUS_ACCOUNT_REQUEST, surplusRemitted } from "./nca-surrender"

const parties = (data: RecoveryNoticeData): string =>
  `In this notice "the Act" means the National Credit Act 34 of 2005, "you" means ${data.borrower.name} and "we" means ${data.lender.legalName}, registered credit provider ${data.lender.ncrNumber}.`

export function recoveryValuationClause(data: RecoveryNoticeData): NcaClause {
  const v = data.valuation
  if (!v) throw new RangeError("Valuation evidence is required")
  return {
    heading: "Consumer rights following repossession and valuation",
    text: [
      `1.1 ${parties(data)} The asset described above was attached under a court order enforcing agreement ${data.reference} and has been held at ${data.location} since ${formatIsoDatePdf(data.recoveredOn)}. Section 131 of the Act applies sections 127(2) to (9) and 128 of the Act to it. This is our notice of its estimated value: ${formatZarPdf(v.amountCents)}, as valued by ${v.valuerName} on ${formatIsoDatePdf(v.valuedOn)}. The estimate is not a guaranteed sale price.`,
      "1.2 Until the asset is sold you may remedy your default by paying all overdue amounts, together with the default charges the Act permits and our reasonable costs of enforcing the agreement up to the time the default is remedied, as section 129(3) of the Act provides, unless section 129(4) of the Act excludes that right. Ask us in writing for the amount. If you remedy the default, we will return the asset to you.",
      "1.3 If the default is not remedied, we must sell the asset as soon as practicable for the best price reasonably obtainable. We will not sell it before 10 business days after you receive this notice.",
      "1.4 After the sale we will credit your account with the proceeds less the reasonable costs of the sale, and send you a written notice of the settlement value of the agreement immediately before the sale, the gross amount realised, the net proceeds and the amount credited or debited to your account, as section 127(5) of the Act requires. Legal costs awarded or taxed under the court order may be charged to your account. If the net proceeds exceed what you owe we will pay you the difference; if they are less, we will demand the balance, and you will have 10 business days after receiving that demand to pay it before we may take further legal steps for it.",
      "1.5 If you dispute this valuation, tell us in writing within 10 business days after you receive this notice. After the sale, section 128 of the Act allows you to apply to the National Consumer Tribunal to review it.",
      SURPLUS_ACCOUNT_REQUEST.replace("the settlement value", "what you owe"),
    ].join("\n\n"),
  }
}

export function recoveryFinalClause(data: RecoveryNoticeData): NcaClause {
  const o = data.outcome
  if (!o) throw new RangeError("Valuation and proceeds evidence are required")
  const shortfall = o.shortfallCents - (o.unrecoverableCostsCents ?? 0)
  const result = shortfall > 0
    ? `1.2 The net proceeds were less than the settlement value together with the costs charged to your account. Under section 127 of the Act we demand payment of the shortfall of ${formatZarPdf(shortfall)}. If you do not pay it within 10 business days after you receive this notice, we may take further legal steps against you for it. Contact us if you cannot pay it in full.`
    : o.surplusCents > 0
      ? surplusRemitted(formatZarPdf(o.surplusCents), "what you owe")
      : "1.2 The net proceeds equalled what you owe. Nothing further is owed by you or by us under the agreement."
  return {
    heading: "Consumer rights following sale and account reconciliation",
    text: [
      `1.1 ${parties(data)} This is our notice under sections 127(5) and 131 of the Act after the sale of the asset attached under agreement ${data.reference}. The figures above show the settlement value immediately before the sale, the gross and net proceeds, the costs deducted from the proceeds or charged to your account, and the result.`,
      result,
      ...(shortfall > 0 ? [SHORTFALL_FREEZE] : []),
      `${shortfall > 0 ? "1.4" : "1.3"} The agreement ends when any shortfall has been paid to us and any surplus has been paid to you. If you believe the sale price or any cost shown is wrong, tell us in writing; section 128 of the Act also allows you to apply to the National Consumer Tribunal to review the sale.`,
    ].join("\n\n"),
  }
}

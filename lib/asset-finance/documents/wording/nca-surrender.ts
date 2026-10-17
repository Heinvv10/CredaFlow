// Clause wording for the s127 voluntary-surrender notices
// (../nca/surrender-pdf.ts). DRAFT for the lender's legal team (the rules behind it are signed off: see DESIGN.md sign-off record 2026-10-17);
// sources and open points: docs/asset-finance/legal-wording/nca.md; code gaps:
// docs/asset-finance/legal-wording/README.md.
import { formatZarPdf } from "@/lib/pdf/helpers"
import type { SurrenderNoticeData } from "../nca/surrender-pdf"
import { formatIsoDatePdf } from "../pdf-layout"
import type { NcaClause } from "./nca-agreement"

/** Asked for at valuation, so a surplus can be remitted with the post-sale notice (s127). Shared with ./nca-recovery.ts. */
export const SURPLUS_ACCOUNT_REQUEST = "1.6 If the sale realises more than the settlement value, section 127 of the Act requires us to remit the surplus to you with our notice after the sale. So that we can, give us in writing, within 10 business days after you receive this notice, the details of a bank account in your name, with proof that it is yours."

/** The surplus sentence of the post-sale notices: remitted with the notice, into the account given at valuation. */
export const surplusRemitted = (amount: string, over: string): string =>
  `1.2 The net proceeds exceeded ${over} by ${amount}. Under section 127 of the Act that amount is due to you, and we remit it to you with this notice, into the bank account you gave us after our valuation notice.`

/** The charge freeze after a shortfall (s127), printed by both post-sale notices under the same condition. */
export const SHORTFALL_FREEZE = "1.3 No interest, fees or charges accrue on your account from the date the sale proceeds were applied until 10 business days after the date of this notice."

const parties = (data: SurrenderNoticeData): string =>
  `In this notice "the Act" means the National Credit Act 34 of 2005, "you" means ${data.borrower.name} and "we" means ${data.lender.legalName}, registered credit provider ${data.lender.ncrNumber}.`

export function surrenderValuationClause(data: SurrenderNoticeData): NcaClause {
  const v = data.valuation
  if (!v) throw new RangeError("Valuation evidence is required")
  return {
    heading: "Consumer rights following valuation",
    text: [
      `1.1 ${parties(data)} On ${formatIsoDatePdf(data.requestDate)} you gave notice under section 127(1) of the Act to terminate agreement ${data.reference} and surrender the asset described above. This is our notice under section 127(2) of the Act: the estimated value of the asset is ${formatZarPdf(v.amountCents)}, as valued by ${v.valuerName} on ${formatIsoDatePdf(v.valuedOn)}. The estimate is not a guaranteed sale price.`,
      "1.2 Within 10 business days after you receive this notice you may unconditionally withdraw your termination notice and resume possession of the asset, unless you are in default under the agreement, as section 127(3) of the Act provides. To withdraw, tell us in writing at the address in the letterhead.",
      "1.3 If you do not withdraw within that period, we must sell the asset as soon as practicable for the best price reasonably obtainable, as section 127(4) of the Act requires. We will not sell it before that period ends. Until the sale, the agreement continues and the amounts due under it remain payable.",
      "1.4 After the sale we will credit your account with the proceeds less the reasonable costs of the sale, and send you a written notice of the settlement value of the agreement immediately before the sale, the gross amount realised, the net proceeds and the amount credited or debited to your account, as section 127(5) of the Act requires. If the net proceeds exceed the settlement value we will pay you the difference. If they are less, we will demand the balance, and you will have 10 business days after receiving that demand to pay it before we may begin legal proceedings for it.",
      "1.5 If you dispute this valuation, tell us in writing within the 10 business days in clause 1.2. After the sale, section 128 of the Act allows you to apply to the National Consumer Tribunal to review it.",
      SURPLUS_ACCOUNT_REQUEST,
    ].join("\n\n"),
  }
}

export function surrenderFinalClause(data: SurrenderNoticeData): NcaClause {
  const r = data.recoveryOutcome
  const shortfall = r ? r.shortfallCents - (r.unrecoverableCostsCents ?? 0) : data.outcome?.shortfallCents ?? 0
  const surplus = r ? r.surplusCents : data.outcome?.refundCents ?? 0
  const result = shortfall > 0
    ? `1.2 The net proceeds were less than the settlement value. Under section 127 of the Act we demand payment of the shortfall of ${formatZarPdf(shortfall)}. If you do not pay it within 10 business days after you receive this notice, we may begin legal proceedings against you for it. Contact us if you cannot pay it in full.`
    : surplus > 0
      ? surplusRemitted(formatZarPdf(surplus), "the settlement value")
      : "1.2 The net proceeds equalled the settlement value. Nothing further is owed by you or by us under the agreement."
  return {
    heading: "Consumer rights following disposal and account reconciliation",
    text: [
      `1.1 ${parties(data)} This is our notice under section 127(5) of the Act after the sale of the asset you surrendered under agreement ${data.reference}. The figures above show the result of the sale and how it was applied to your account.`,
      result,
      ...(shortfall > 0 ? [SHORTFALL_FREEZE] : []),
      `${shortfall > 0 ? "1.4" : "1.3"} The agreement ends when any shortfall has been paid to us and any surplus has been paid to you. If you believe the sale price or any cost shown is wrong, tell us in writing; section 128 of the Act also allows you to apply to the National Consumer Tribunal to review the sale.`,
    ].join("\n\n"),
  }
}

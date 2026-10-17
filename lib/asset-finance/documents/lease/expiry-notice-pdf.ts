// The CPA s14 expiry notice of a fixed-term lease (slice 3, C9): the lessee is
// told, 40 to 80 business days before the term expires, that it is expiring
// and what the options are (the notice row is queued by lib/asset-finance/
// lease-expiry.ts). Real data: lessee, lease, goods, expiry date, the lender's
// contacts. The consequence of doing nothing is drafted wording
// (../wording/lease-servicing.ts) for the lender's legal team to approve.
// Deterministic; DRAFT watermark.
// The notice's content and the options it lists: wording drafted 2026-10-17, awaits the lender's legal approval
// (TenantConfig.assetFinanceLegalWordingApproved).
import { formatIsoDatePdf } from "../pdf-layout"
import { expiryNoticeClauses } from "../wording/lease-servicing"
import { contactRows, finishLeaseDocument, leaseRows, openLeaseDocument } from "./lease-docs-parts"
import type { ExpiryNoticeData, LeaseDocLender } from "./lease-docs-types"

export async function renderLeaseExpiryNotice(data: ExpiryNoticeData, lender: LeaseDocLender): Promise<Buffer> {
  const w = await openLeaseDocument(lender, data, {
    title: "Notice of expiry of your lease",
    subtitle: `Lease ${data.reference} · issued ${formatIsoDatePdf(data.queuedOn)}`,
    dateIso: data.queuedOn,
  })
  w.section("1. THE LEASE")
  w.labelValues([...leaseRows(data), ["Expiry date", formatIsoDatePdf(data.expiryDate)]])
  w.section("2. WHAT THIS NOTICE IS")
  w.paragraph(
    `Your lease of the goods above is for a fixed term and expires on ${formatIsoDatePdf(data.expiryDate)}. `
    + "The Consumer Protection Act, 2008 applies to it, and this notice tells you what you may do before that date.",
  )
  w.section("3. YOUR OPTIONS AT EXPIRY")
  w.labelValues([
    ["Return the goods", "Return the goods to the lessor on or before the expiry date. The goods are inspected on return; damage beyond fair wear and tear, and any usage above the contracted usage, is invoiced."],
    ["Extend month to month", `Continue the lease month to month on the same rentals. Either of us may end the extension by giving ${data.extensionNoticeMonths === 1 ? "one month's" : `${data.extensionNoticeMonths} months'`} notice.`],
    ["Buy the goods", "Buy the goods from the lessor at their fair market value on a valuation dated shortly before the purchase. The price is not fixed in the lease agreement."],
  ])
  w.section("4. IF YOU DO NOTHING")
  // What happens when the lessee neither returns, extends nor buys: wording drafted 2026-10-17, awaits legal approval.
  expiryNoticeClauses(data).forEach((c, i) => w.clause(`4.${i + 1}`, c.heading, c.text))
  w.section("5. HOW TO REACH US")
  w.labelValues(contactRows(lender))
  return finishLeaseDocument(w, data)
}

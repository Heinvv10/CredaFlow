import type { WordingClause } from "./commercial-common"

/** CPA scope is snapshotted from the purchaser's evidenced turnover/assets. */
export function cpaInstalmentSaleClauses(clauses: WordingClause[]): WordingClause[] {
  return clauses.map((clause, i) => {
    if (i === 0) return { ...clause, text: `${clause.text}\n\nThe Consumer Protection Act 68 of 2008 applies to the supply of the Goods. The Seller does not exclude the Purchaser's rights under sections 55 and 56. The warranty exclusions and the obligation to continue payment above operate only to the extent permitted by that Act. The Purchaser may exercise its statutory remedies for defective Goods, including repair, replacement or refund where section 56 provides for them.` }
    if (i === 1) return { ...clause, text: `${clause.text}\n\nNOTICE UNDER SECTION 49: Risk of loss or damage passes to the Purchaser on delivery. The indemnity above may impose liability on the Purchaser for third-party claims arising from its use of the Goods. It does not exclude or limit liability for the Seller's gross negligence or for any loss for which liability may not lawfully be excluded. The Seller draws these terms to the Purchaser's attention before signature; the Purchaser must have an adequate opportunity to understand them.` }
    if (i === 8) return { ...clause, text: `${clause.text}\n\nAny costs claimed must be reasonable and recoverable by law. Nothing in this clause permits an unfair, unreasonable or unjust charge contrary to section 48 of the Consumer Protection Act.` }
    if (i === 10) return { ...clause, text: `${clause.text}\n\nNo cession or delegation reduces a right or remedy the Purchaser has under the Consumer Protection Act.` }
    return clause
  })
}

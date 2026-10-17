// The deed of suretyship's clauses (./../suretyship-pdf.ts section 5). DRAFT
// wording for the lender's legal team (the rules behind it are signed off: see DESIGN.md sign-off record 2026-10-17);
// the DRAFT watermark prints until TenantConfig.assetFinanceLegalWordingApproved.
//
// Two variants. A suretyship is a credit guarantee, and the NCA applies to one
// only to the extent it applies to the principal agreement (NCA s4(2)(c)). So
// a surety for a non-NCA deal gets the usual commercial terms; a surety where
// the application is not NON_NCA (data.ncaApplies, ../deal-document-data.ts)
// gets a variant that leaves out the terms most open to challenge under s90: no
// certificate of balance as proof, no consent to jurisdiction, no pre-agreed
// cost scale, no renounced evidential exceptions, no variation of the
// Agreement without the surety. It still renounces excussion and division;
// whether that survives s90 is an open point for legal (commercial.md).
// Notes and sources: docs/asset-finance/legal-wording/commercial.md.
import type { DealDocumentData, DocumentPerson } from "../deal-document-data"
import type { WordingClause } from "./commercial-common"

function principal(data: DealDocumentData, surety: DocumentPerson): WordingClause {
  return {
    heading: "Suretyship and co-principal debtor",
    text: `${surety.name} ("the Surety") is bound to the creditor in section 2 ("the Creditor") as surety for, and as co-principal debtor jointly and severally with, the principal debtor in section 3 ("the Principal Debtor"), ${data.entity.legalName}, for the due and punctual payment and performance of every obligation of the Principal Debtor under the agreement with the agreement reference ${data.reference} described in section 4 ("the Agreement").

As co-principal debtor, the Surety is liable to the Creditor jointly and severally with the Principal Debtor and with every other surety for the Principal Debtor's obligations under the Agreement, and the Creditor may claim payment from the Surety without first claiming from the Principal Debtor, any other surety, or any other security.`,
  }
}

function extent(nca: boolean): WordingClause {
  const costs = nca
    ? "and the costs of enforcing this deed that the Creditor may lawfully recover under the National Credit Act 34 of 2005, including section 101(1)(g)"
    : "and all legal costs of enforcing this deed, on the scale as between attorney and own client"
  return {
    heading: "Extent of the suretyship",
    text: `This suretyship covers every amount the Principal Debtor owes or will owe the Creditor under or arising from the Agreement: capital, interest (including interest at a changed contract rate under the Agreement's terms), the balloon or residual, default interest, fees and costs, and any claim for damages or for repayment if the Agreement is cancelled, ${costs}.

The total payable shown in section 4 is the amount payable under the Agreement as signed. The Surety's liability is not limited to it, because interest, charges and costs accrue on late payment and the contract rate may change under the Agreement.`,
  }
}

function renunciation(nca: boolean): WordingClause {
  return {
    heading: "Renunciation of benefits",
    text: nca
      ? `The Surety renounces the benefit of excussion (beneficium ordinis seu excussionis), under which a creditor must first claim from the principal debtor, and the benefit of division (beneficium divisionis), under which a creditor must divide its claim among co-sureties. Nothing in this deed limits any right the Surety has under the National Credit Act 34 of 2005.`
      : `The Surety renounces the benefits of excussion (beneficium ordinis seu excussionis), under which a creditor must first claim from the principal debtor; of division (beneficium divisionis), under which a creditor must divide its claim among co-sureties; and of cession of actions (beneficium cedendarum actionum), under which a paying surety may require the creditor to cede its rights of action first. The Surety also renounces the exceptions non numeratae pecuniae (that no money was paid), non causa debiti (that there was no valid cause of debt) and errore calculi (that the amount was miscalculated), and the Surety declares that the Surety knows the meaning and effect of each benefit and exception renounced.`,
  }
}

function continuing(nca: boolean): WordingClause {
  const variation = nca
    ? "The Creditor may, without the Surety's consent and without affecting the Surety's liability, give the Principal Debtor time to pay or any other indulgence, apply a change in the contract rate under the Agreement's terms, and release any other surety or security. Any other variation of the Agreement that increases the Principal Debtor's obligations binds the Surety only if the Surety consents to it in writing."
    : "The Creditor may, without the Surety's consent and without affecting the Surety's liability, give the Principal Debtor time to pay or any other indulgence, vary, extend or reschedule the Agreement (including by recalculating payments after a change in the contract rate), compromise with the Principal Debtor, and release, substitute or realise any other surety or security."
  return {
    heading: "Continuing covering security",
    text: `This suretyship is a continuing covering security. It stays in force until every obligation of the Principal Debtor under the Agreement has been discharged in full, regardless of any intermediate payment or fluctuation in the amount owing, and despite the death or sequestration of the Surety (it binds the Surety's estate) or the liquidation, business rescue, deregistration or dissolution of the Principal Debtor. The Surety may not withdraw from this suretyship while any amount is owing under the Agreement.

${variation}

If any payment to the Creditor on account of the Agreement is later set aside or repaid under any law relating to insolvency or business rescue, the Surety remains liable as if that payment had not been made.`,
  }
}

function certificate(nca: boolean): WordingClause {
  return {
    heading: "Certificate of balance",
    text: nca
      ? "On request the Creditor gives the Surety a written statement of the amount owing under the Agreement and how it is made up. The Surety may dispute the statement, and it has no evidential weight other than what the law gives it."
      : "A certificate signed by any manager of the Creditor, whose appointment need not be proved, stating the amount owing under the Agreement and that it is due, is prima facie proof of its contents for all purposes, including summary judgment and provisional sentence against the Surety.",
  }
}

function notices(data: DealDocumentData, surety: DocumentPerson): WordingClause {
  return {
    heading: "Domicilium and notices",
    text: `The Creditor chooses its registered office at ${data.lender.registeredOfficeLines.join(", ")} as its domicilium citandi et executandi, where notices and legal process may be delivered. The Surety chooses as its domicilium ${surety.addressLines?.join(", ") || "the physical address to be recorded in section 1 before execution"}. Either may change its domicilium to another physical address in the Republic of South Africa by written notice to the other.

A notice under this deed must be in writing. A notice delivered by hand to a domicilium is received on delivery, and one sent by prepaid registered post to it is received on the 7th business day after posting. A notice actually received is effective even if it was not delivered in one of these ways.`,
  }
}

function spouse(): WordingClause {
  return {
    heading: "Marital status and spouse's consent",
    text: `The Surety warrants that the Surety is unmarried, or is married out of community of property, or is married in community of property and the Surety's spouse consents in writing to this suretyship by signing it where indicated below, in the presence of two competent witnesses who also sign, as sections 15(2)(h) and 15(5) of the Matrimonial Property Act 88 of 1984 require for a spouse married in community of property who binds himself or herself as surety.`,
  }
}

function general(nca: boolean): WordingClause {
  const forum = nca
    ? "This deed is governed by the law of the Republic of South Africa."
    : "The Surety consents, under section 45 of the Magistrates' Courts Act 32 of 1944, to the jurisdiction of any magistrate's court having jurisdiction over the Surety in any proceedings arising from this deed, even if the amount claimed exceeds that court's jurisdiction; the Creditor may instead bring proceedings in any other competent court. This deed is governed by the law of the Republic of South Africa."
  return {
    heading: "General",
    text: `This deed is the whole agreement between the Creditor and the Surety about its subject matter. No variation or cancellation of it, and no release of the Surety, has any effect unless it is in writing and signed by the Creditor. No indulgence or delay by the Creditor is a waiver of any right. The Creditor accepts this suretyship by acting on it and need not sign it. If any provision of this deed is unenforceable, the remaining provisions stay in force. The Creditor may cede its rights under this deed together with its rights under the Agreement.

${forum}

The Surety consents to the Creditor processing the Surety's personal information, including obtaining and sharing it with credit bureaux, to assess, conclude, administer and enforce this suretyship and the Agreement, in accordance with the Protection of Personal Information Act 4 of 2013.`,
  }
}

/** Clauses 5.1 to 5.8 in printed order. */
export function suretyshipClauses(data: DealDocumentData, surety: DocumentPerson): WordingClause[] {
  const nca = data.ncaApplies
  return [
    principal(data, surety),
    extent(nca),
    renunciation(nca),
    continuing(nca),
    certificate(nca),
    notices(data, surety),
    spouse(),
    general(nca),
  ]
}

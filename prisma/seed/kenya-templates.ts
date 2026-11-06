/**
 * The documents of the Kenyan demo lender (DEMO_LENDER=nairobi): an offer letter, a key facts
 * statement, a loan agreement and an arrears letter, under the same keys as the Lesotho ones
 * (./non-nca-templates.ts picks these when the lender is KE).
 *
 * DRAFT — not reviewed by Kenyan counsel. Every word here is a placeholder for a demo: nothing in
 * it is approved wording, and the version notes the seed writes say so. The lender's legal wording
 * is the lender's to supply; as for Lesotho these are STRUCTURE only (the parties, the approved
 * figures, a gap for the CBK licence and the M-Pesa repayment route) with the same marked gap where the legal
 * text goes, and every document of a demo lender opens with the SAMPLE banner
 * (lib/non-nca-documents/render.ts). Not NCA wording: lib/pdf is not involved.
 *
 * The Paybill business number is not printed: the borrower reads it in the client portal. A loan
 * reference exists only once the loan is paid out, so the key facts statement names it as the
 * account number without printing one; the arrears letter, written for a booked loan, prints it.
 */
export const KENYA_TEMPLATE_NOTES = "DRAFT — not reviewed by Kenyan counsel. Synthetic demo version: structure, approved figures and the M-Pesa repayment route only. The lender's Kenyan counsel supplies the wording."

const GAP = "<p><em>[SAMPLE &mdash; the bank&rsquo;s legal team supplies wording. No legal text is provided here.]</em></p>"

// The demo lender holds no Central Bank of Kenya licence, and the lender identity has no field for one, so the
// documents assert none: a marked gap where a licensed lender's counsel puts its licence statement and number.
const REGULATOR = "<p><em>[SAMPLE &mdash; the lender&rsquo;s Central Bank of Kenya licence number goes here. This demo lender holds no licence.]</em></p>"

const FIGURES = `<table>
<tr><td>Loan amount</td><td>{{quote.principal}}</td></tr>
<tr><td>Term</td><td>{{quote.term}}</td></tr>
<tr><td>Interest rate</td><td>{{quote.interestRate}}</td></tr>
<tr><td>Initiation fee</td><td>{{quote.initiationFee}}</td></tr>
<tr><td>Service fees over the term</td><td>{{quote.serviceFees}}</td></tr>
<tr><td>Number of instalments</td><td>{{quote.instalments}}</td></tr>
<tr><td>Instalment</td><td>{{quote.instalment}}</td></tr>
<tr><td>First instalment due</td><td>{{quote.firstDueDate}}</td></tr>
<tr><td>Last instalment due</td><td>{{quote.lastDueDate}}</td></tr>
<tr><td>Total interest</td><td>{{quote.totalInterest}}</td></tr>
<tr><td>Total repayable</td><td>{{quote.totalRepayable}}</td></tr>
<tr><td>Repayment method</td><td>{{quote.repaymentMethod}}</td></tr>
</table>`

const PARTIES = `<p>Lender: {{tenant.legalName}}</p>
<p>Borrower: {{client.fullName}}, national ID number {{client.idNumber}}</p>
<p>Application: {{application.reference}} &mdash; {{application.product}}</p>`

const MPESA_BEFORE_PAYOUT = `<h2>Repaying by M-Pesa Paybill</h2>
<ol>
<li>On M-Pesa, choose Lipa na M-Pesa, then Paybill.</li>
<li>Business number: the lender&rsquo;s Paybill number, shown in your client portal.</li>
<li>Account number: your loan reference, which you receive when the loan is paid out.</li>
<li>Enter the instalment amount and your M-Pesa PIN, and keep the M-Pesa confirmation message.</li>
</ol>`

const MPESA_FOR_LOAN = `<h2>Paying by M-Pesa Paybill</h2>
<p>On M-Pesa, choose Lipa na M-Pesa, then Paybill. Business number: the lender&rsquo;s Paybill number, shown in your client portal. Account number: {{loan.reference}}.</p>`

const ARREARS = `<table>
<tr><td>Loan reference</td><td>{{loan.reference}}</td></tr>
<tr><td>Date of this letter</td><td>{{arrears.noticeDate}}</td></tr>
<tr><td>Amount in arrears</td><td>{{arrears.amount}}</td></tr>
<tr><td>Days in arrears</td><td>{{arrears.days}}</td></tr>
<tr><td>Total outstanding</td><td>{{arrears.totalOutstanding}}</td></tr>
</table>`

export const KENYA_TEMPLATE_BODIES = {
  OFFER_LETTER: `<h1>Offer letter</h1>\n${REGULATOR}\n${PARTIES}\n${FIGURES}\n${GAP}\n<p>Prepared {{today}}.</p>`,
  ARREARS_LETTER: `<h1>Arrears letter</h1>\n${REGULATOR}\n<p>Lender: {{tenant.legalName}}</p>\n<p>Borrower: {{client.fullName}}</p>\n${ARREARS}\n${MPESA_FOR_LOAN}\n${GAP}`,
  KEY_FACTS_STATEMENT: `<h1>Key facts statement</h1>\n${REGULATOR}\n${PARTIES}\n${FIGURES}\n${MPESA_BEFORE_PAYOUT}\n${GAP}\n<p>Prepared {{today}}.</p>`,
  LOAN_AGREEMENT: `<h1>Loan agreement</h1>\n${REGULATOR}\n${PARTIES}\n<h2>Approved terms</h2>\n${FIGURES}\n${MPESA_BEFORE_PAYOUT}\n<h2>Terms and conditions</h2>\n${GAP}\n<p>Prepared {{today}}.</p>`,
} as const

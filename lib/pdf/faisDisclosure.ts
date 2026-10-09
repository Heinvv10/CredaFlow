// lib/pdf/faisDisclosure.ts
import { PDFDocument, PDFPage, PDFFont, StandardFonts } from "pdf-lib"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN,
  DARK, ACCENT, GRAY,
  formatZarPdf, formatDatePdf,
  drawText, drawSectionTitle, drawPageNumber,
  embedLogo, drawLogoChip,
} from "./helpers"
import { requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"

// Fix I2: plain-language labels for InsurancePolicyType enum values (match prisma/schema.prisma exactly)
const PRODUCT_TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER:       "Funeral Cover",
  CREDIT_LIFE:         "Credit Life Insurance",
  LIFE_INSURANCE:      "Life Insurance",
  SHORT_TERM_MOTOR:    "Motor Insurance",
  SHORT_TERM_HOME:     "Home Insurance",
  SHORT_TERM_CONTENTS: "Contents Insurance",
  BUSINESS_INSURANCE:  "Business Insurance",
}

export interface FaisInput {
  /** The FSP: its legal name, FSP licence number ("FSP No.") and NCR number. */
  lender: Pick<LenderIdentity, "legalName" | "fspNumber" | "ncrNumber">
  /** Letterhead logo, PNG bytes. Absent → text header. */
  logo?: Uint8Array
  client: { firstName: string; lastName: string; idNumber: string }
  advisor: { name: string; designation: string }
  product: { type: string; name: string; insurer?: string }
  policyDraft: {
    sumAssured: number    // rands (callers must pass rands — formatZarPdf below converts to cents via * 100)
    premiumAmount: number // rands
    term?: string
  }
  /**
   * The lives this cover applies to, when the policy is multi-life.
   *
   * OMITTED for the legacy single-life standalone flow, where the client IS the
   * only covered life and the Client section already names them. Supplied by
   * the quote path, where `sumAssured` and `premiumAmount` above are TOTALS
   * across several people — and a disclosure that showed only a total would
   * misstate who is covered, which is the one thing a FAIS disclosure may not
   * do. Amounts are rands, matching policyDraft.
   */
  lives?: {
    firstName: string
    lastName: string
    lifeType: string
    relationship: string
    sumAssured: number
    premiumAmount: number | null
  }[]
  issuedAt?: Date
}

// LEGAL_WORDING_BEGIN — G1 FAIS disclosure wording. Compliance-officer
// sign-off covers this wording. Do NOT edit this block
// without a fresh compliance review — each clause is annotated with its
// regulatory citation so legal can re-verify against source text.
//
// Sources:
//   FAIS GCOC : Board Notice 80 of 2003 (as amended through BN 194 of 2017
//               and the 2020 amendments) — sections 4, 5, 7 and Part X.
//   PPR-LTI   : Policyholder Protection Rules (Long-term Insurance), 2017
//               (Government Notice 1407), Rule 11 (cooling-off).
//
// CAUTION: line width at 9.5pt Helvetica is roughly 95 chars; keep each
// array entry below ~78 chars so the rendered line never clips the right
// margin. drawText() in this template does NOT wrap — one entry, one line.
//
// Clause 2 opens with the provider's legal name, so its lines are built per
// lender (PROVIDER_CLAUSE below); its wording is CLAUSE_2_AFTER_NAME.
const CLAUSE_2_AFTER_NAME =
  "is authorised to render intermediary services in the product categories " +
  "covered by its FSP licence, subject to the conditions of that licence. " +
  "We accept responsibility for the actions of our representatives in the " +
  "rendering of this financial service."
const PROVIDER_CLAUSE = Symbol("clause 2, opening with the provider's legal name")
const FAIS_DISCLOSURE_BODY = [
  // ── Clause 1 — FAIS GCOC s5(a)(d): info about the provider ───────────────
  "1. About this disclosure (FAIS GCOC s5).",
  "   This document is provided to you under the General Code of Conduct for",
  "   Authorised Financial Services Providers and Representatives (Board",
  "   Notice 80 of 2003, as amended) under the Financial Advisory and",
  "   Intermediary Services Act, 37 of 2002. Our registered name, NCR credit",
  "   provider registration number, FSP licence number and contact details",
  "   appear in the Financial Services Provider section above.",
  "",
  // ── Clause 2 — FAIS GCOC s5(b)(d): provider's legal/contractual status ───
  "2. Our authorisation and scope (FAIS GCOC s5(b) and (d)).",
  PROVIDER_CLAUSE,
  "",
  // ── Clause 3 — FAIS GCOC s5(e): PI / fidelity cover ──────────────────────
  "3. Professional indemnity cover (FAIS GCOC s5(e)).",
  "   We hold professional indemnity insurance cover in respect of the",
  "   financial services we render.",
  "",
  // ── Clause 4 — FAIS GCOC s4(1)(a)(b): product supplier disclosure ────────
  "4. Product supplier (FAIS GCOC s4).",
  "   The insurance product disclosed below is issued by the insurer named in",
  "   the Product section above. We have a contractual relationship with that",
  "   insurer for the intermediation of this product. The insurer's full",
  "   contact details and complaints department appear in the policy document",
  "   issued at inception.",
  "",
  // ── Clause 5 — FAIS GCOC s7(1)(c)(i)-(ii): benefits + how calculated ─────
  "5. Nature and extent of benefits (FAIS GCOC s7(1)(c)(i)-(ii)).",
  "   The benefits payable under this policy, the events on which they are",
  "   payable and the manner in which they are calculated and paid are set",
  "   out in the policy schedule issued on inception.",
  "",
  // ── Clause 6 — FAIS GCOC s7(1)(c)(iv)-(v): monetary obligations ──────────
  "6. Monetary obligations (FAIS GCOC s7(1)(c)(iv) and (v)).",
  "   You undertake to pay the premium shown above at the stated frequency.",
  "   Non-payment may result in suspension or termination of cover in",
  "   accordance with the policy schedule.",
  "",
  // ── Clause 7 — FAIS GCOC s7(1)(c)(vii): exclusions, waiting periods ──────
  "7. Exclusions, waiting periods and restrictions (FAIS GCOC s7(1)(c)(vii)).",
  "   The policy contains exclusions, waiting periods and limitations of",
  "   cover. These are set out in the policy schedule and will be explained",
  "   to you on the date of issue and communicated at regular intervals",
  "   thereafter.",
  "",
  // ── Clause 8 — FAIS GCOC s7(1)(c)(xii) + PPR-LTI Rule 11 ─────────────────
  "8. Cooling-off rights (FAIS GCOC s7(1)(c)(xii); PPR-LTI Rule 11).",
  "   Where the policy is a long-term insurance policy, you may exercise the",
  "   31-day cooling-off right in Rule 11 of the Policyholder Protection",
  "   Rules (Long-term Insurance), 2017, by written notice to the insurer",
  "   provided no benefit has yet been paid or claimed and no event insured",
  "   against has occurred.",
  "",
  // ── Clause 9 — FAIS GCOC s7(1)(d)(i)-(iii): accuracy of disclosure ───────
  "9. Accuracy of disclosure (FAIS GCOC s7(1)(d)).",
  "   The accuracy and completeness of all answers, statements and",
  "   information you provide are your responsibility. Misrepresentation or",
  "   non-disclosure of a material fact may result in the policy being",
  "   voided or claims being rejected.",
  "",
  // ── Clause 10 — FAIS GCOC Part X (s17-20): complaints procedure ──────────
  "10. Complaints (FAIS GCOC Part X, sections 17-20).",
  "    Complaints should first be raised with our Compliance Officer at the",
  "    contact details above. If the complaint remains unresolved you may",
  "    refer it to the Office of the FAIS Ombud:",
  "      Postal: PO Box 41, Menlyn Park, 0063",
  "      Tel:    012 762 5000 (Sharecall: 086 066 3274)",
  "      Email:  info@faisombud.co.za   Web: www.faisombud.co.za",
] as const
// LEGAL_WORDING_END

/** Clause 2's text wraps at 72 columns after its 3-space indent: the width the
 *  approved block was hand-wrapped to, so a name the length of the one it was
 *  approved with breaks on exactly the approved lines. */
const CLAUSE_WIDTH = 72

function faisDisclosureBody(legalName: string): string[] {
  return FAIS_DISCLOSURE_BODY.flatMap((entry) => {
    if (entry !== PROVIDER_CLAUSE) return [entry]
    const lines: string[] = []
    let current = ""
    for (const word of `${legalName} ${CLAUSE_2_AFTER_NAME}`.split(" ")) {
      const next = current ? `${current} ${word}` : word
      if (next.length > CLAUSE_WIDTH && current) {
        lines.push(current)
        current = word
      } else {
        current = next
      }
    }
    if (current) lines.push(current)
    return lines.map((line) => `   ${line}`)
  })
}

// Fix I1: guard against page overflow — adds a new page when y is too close to bottom margin
async function ensureRoom(
  doc: PDFDocument,
  page: PDFPage,
  y: number,
  _font: PDFFont,
  margin: number,
  headerHeight: number,
): Promise<{ page: PDFPage; y: number }> {
  if (y > margin + 20) return { page, y }
  const newPage = doc.addPage([A4_WIDTH, A4_HEIGHT])
  return { page: newPage, y: A4_HEIGHT - headerHeight }
}

export async function generateFaisDisclosurePdf(input: FaisInput): Promise<Buffer> {
  const { client, advisor, product, policyDraft, lives } = input
  const lender = requireLenderIdentityFields(input.lender, ["legalName", "fspNumber", "ncrNumber"])
  const issuedAt = input.issuedAt ?? new Date()

  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  // Fix I1: use let so page/y can be reassigned by ensureRoom
  let page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN

  // Header band
  const barHeight = 70
  page.drawRectangle({ x: 0, y: A4_HEIGHT - barHeight, width: A4_WIDTH, height: barHeight, color: DARK })
  const logo = await embedLogo(doc, input.logo)
  if (logo) {
    const heading = "FAIS Disclosure (General Code of Conduct, sections 4, 5 + 7)"
    const textX = drawLogoChip(page, logo, MARGIN, A4_HEIGHT, barHeight, regular.widthOfTextAtSize(heading, 9))
    drawText(page, heading, textX, A4_HEIGHT - 38, regular, 9, ACCENT)
  } else {
    drawText(page, lender.legalName, MARGIN, A4_HEIGHT - 38, bold, 14, ACCENT)
    drawText(page, "FAIS Disclosure (General Code of Conduct, sections 4, 5 + 7)", MARGIN, A4_HEIGHT - 56, regular, 9, ACCENT)
  }
  y = A4_HEIGHT - 100

  // Issued-on line
  drawText(page, `Issued: ${formatDatePdf(issuedAt)}`, MARGIN, y, regular, 10, GRAY)
  y -= 24

  // FSP section
  y = drawSectionTitle(page, y, "Financial Services Provider", bold)
  drawText(page, `FSP: ${lender.legalName}`, MARGIN, y, regular, 10, DARK); y -= 14
  drawText(page, `FSP No.: ${lender.fspNumber}`, MARGIN, y, regular, 10, DARK); y -= 14
  drawText(page, `NCR Reg.: ${lender.ncrNumber}`, MARGIN, y, regular, 10, DARK); y -= 14
  y -= 8

  // Advisor section
  y = drawSectionTitle(page, y, "Authorised Representative", bold)
  drawText(page, `Name: ${advisor.name}`, MARGIN, y, regular, 10, DARK); y -= 14
  drawText(page, `Designation: ${advisor.designation}`, MARGIN, y, regular, 10, DARK); y -= 14
  y -= 8

  // Product section
  y = drawSectionTitle(page, y, "Product", bold)
  // Fix I2: use plain-language label instead of raw enum value
  drawText(page, `Type: ${PRODUCT_TYPE_LABELS[product.type] ?? product.type}`, MARGIN, y, regular, 10, DARK); y -= 14
  drawText(page, `Name: ${product.name}`, MARGIN, y, regular, 10, DARK); y -= 14
  if (product.insurer) { drawText(page, `Insurer: ${product.insurer}`, MARGIN, y, regular, 10, DARK); y -= 14 }
  // Fix C1: policyDraft values are in rands; multiply by 100 to convert to cents for formatZarPdf
  drawText(page, `Sum assured: ${formatZarPdf(policyDraft.sumAssured * 100)}`, MARGIN, y, regular, 10, DARK); y -= 14 // rands → cents for formatZarPdf
  drawText(
    page,
    `Premium: ${formatZarPdf(policyDraft.premiumAmount * 100)}` + (policyDraft.term ? ` per period · ${policyDraft.term}` : ""), // rands → cents for formatZarPdf
    MARGIN, y, regular, 10, DARK
  ); y -= 14
  y -= 8

  // Lives covered — multi-life only. Rendered BEFORE the statutory wording so
  // the compliance-signed LEGAL_WORDING block below is untouched, and each life
  // is listed with its own cover and its own premium so the totals above are
  // accounted for rather than merely asserted.
  if (lives && lives.length > 0) {
    ;({ page, y } = await ensureRoom(doc, page, y, regular, MARGIN, 70))
    y = drawSectionTitle(page, y, "Lives covered", bold)
    for (const life of lives) {
      ;({ page, y } = await ensureRoom(doc, page, y, regular, MARGIN, 70))
      const premium = life.premiumAmount === null
        ? "not rated"
        : formatZarPdf(life.premiumAmount * 100)
      drawText(
        page,
        `${life.firstName} ${life.lastName} (${life.relationship}) · cover ${formatZarPdf(life.sumAssured * 100)} · premium ${premium}`,
        MARGIN, y, regular, 10, DARK,
      )
      y -= 14
    }
    y -= 8
  }

  // Client section
  y = drawSectionTitle(page, y, "Client", bold)
  drawText(page, `Name: ${client.firstName} ${client.lastName}`, MARGIN, y, regular, 10, DARK); y -= 14
  drawText(page, `ID: ${client.idNumber}`, MARGIN, y, regular, 10, DARK); y -= 22

  // Fix I1: guard before "Statutory Disclosure" section
  ;({ page, y } = await ensureRoom(doc, page, y, regular, MARGIN, 70))

  // Statutory disclosure section.
  // Guard BEFORE drawing each line — not after a fixed batch — so no line can
  // be drawn below the bottom margin. The previous "every 10 lines, after
  // drawing" guard fit the 5-line stub but left the compliance-signed-off
  // 60+-line body able to clip a clause off the bottom of page 1 (F-25).
  y = drawSectionTitle(page, y, "Statutory Disclosure", bold)
  for (const line of faisDisclosureBody(lender.legalName)) {
    ;({ page, y } = await ensureRoom(doc, page, y, regular, MARGIN, 70))
    drawText(page, line, MARGIN, y, regular, 9.5, DARK)
    y -= 13
  }
  y -= 10

  // Fix I1: guard before "Client acknowledgement" section
  ;({ page, y } = await ensureRoom(doc, page, y, regular, MARGIN, 70))

  // Client acknowledgement section
  y = drawSectionTitle(page, y, "Client acknowledgement", bold)
  drawText(page, "I confirm that the advisor walked me through this disclosure and that I", MARGIN, y, regular, 10, DARK); y -= 14
  drawText(page, "had the opportunity to ask questions before proceeding.", MARGIN, y, regular, 10, DARK); y -= 22
  drawText(page, "Signature: ____________________________", MARGIN, y, regular, 10, DARK); y -= 18
  drawText(page, "Date:      ____________________________", MARGIN, y, regular, 10, DARK)

  // Fix I1: draw page number footer on every page
  const pages = doc.getPages()
  pages.forEach((p, i) => drawPageNumber(p, i + 1, pages.length, regular))

  const bytes = await doc.save()
  return Buffer.from(bytes)
}

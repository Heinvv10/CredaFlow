import { PDFDocument, StandardFonts } from "pdf-lib"
import type { PDFFont, PDFPage } from "pdf-lib"
import type { AgreementRuleAnchor, AgreementSignatureAnchors } from "./creditAgreement"
import { LenderIdentityError, requireLenderIdentityFields, type LenderIdentity } from "@/lib/config/identity-schema"
import {
  A4_WIDTH, A4_HEIGHT, MARGIN,
  DARK, GRAY,
  formatDatePdf, drawText,
} from "./helpers"

/**
 * Producing the EXECUTED credit agreement — the single artifact that carries
 * both signatures.
 *
 * It is built by stamping the signatures onto the STORED unsigned document
 * rather than by re-rendering that document from evidence. That choice is the
 * whole safety argument: the executed artifact demonstrably contains the exact
 * bytes the consumer was shown and signed, so there is no reproduction step
 * that could drift, and no way to mint an authoritative-looking agreement whose
 * content differs from the one that was signed.
 *
 * (A re-render was the original design. It cannot carry that proof cheaply:
 * pdf-lib stamps CreationDate/ModDate at save, so a re-render never reproduces
 * the stored file's digest — lib/pdf/__tests__/creditAgreement.test.ts pins
 * that instability deliberately. Comparing content streams instead would work,
 * but only after reassembling ~79 evidence fields, and any drift in live
 * config would then block countersignature on a live loan.)
 */

export interface AgreementExecution {
  /** PNG data URL (drawn signature) or a typed name. */
  consumerSignature: string
  consumerSignedAt: Date
  /** PNG data URL (drawn signature) or a typed name. */
  providerSignature: string
  providerName: string
  countersignedAt: Date
}

/**
 * Who the agreement is between, printed on an appended execution page so that
 * page is attributable on its own. The body pages already carry all of this;
 * an appended page would otherwise be a signature attached to nothing.
 */
export interface ExecutedAgreementIdentity {
  /** The credit provider, as the agreement's body pages name it. */
  lender: Pick<LenderIdentity, "legalName" | "ncrNumber">
  clientName: string
  clientIdNumber: string
  applicationReference: string
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,"

/**
 * `agreementSignatureData` does not always hold a signature.
 *
 * When staff record a returned PAPER packet, the sign route stores the machine
 * token `signed-packet-v1:<documentId>:<sha256>` in that column instead — the
 * consumer's actual signature exists only as pixels inside the uploaded scan.
 * Drawing that token would print a 100+ character reference onto the
 * consumer's signature rule of a statutory credit agreement, overrunning the
 * date column with it.
 *
 * See app/api/applications/[id]/agreement/sign/route.ts (recordsReturnedPacket).
 */
const RETURNED_PACKET_SENTINEL_PREFIX = "signed-packet-v1:"

/** True when the stored artefact is a reference to a scan, not something that
 *  can be drawn as a signature. */
export function isReturnedPacketReference(artefact: string): boolean {
  return artefact.startsWith(RETURNED_PACKET_SENTINEL_PREFIX)
}

/** How the executed artifact was produced, recorded so the audit trail states
 *  which mechanism ran rather than leaving it to be inferred. */
export type ExecutedAgreementMethod = "stamped" | "execution_page"

export interface ExecutedAgreementResult {
  bytes: Buffer
  method: ExecutedAgreementMethod
  /**
   * Whether each signature was actually DRAWN, as opposed to replaced by a note
   * ("[signature on record]", "[signed on the returned packet]").
   *
   * Recorded because the method alone cannot distinguish "both signatures are
   * visible on the page" from "the consumer's artefact was a scan reference or
   * would not encode" — on a document whose entire purpose is to evidence that
   * signature, that difference belongs in the audit trail rather than being
   * discoverable only by opening the PDF.
   */
  consumerSignatureRendered: boolean
  providerSignatureRendered: boolean
}

/** Below this a rule cannot hold a legible signature — see the anchor validator. */
const MIN_RULE_WIDTH = 20
/** Tallest a stamped signature image is scaled to. Shared with the validator so
 *  an anchor is only accepted where the whole stamp actually fits. */
const MAX_SIGNATURE_HEIGHT = 34

/**
 * Parse anchors back out of the persisted artifact manifest.
 *
 * Fail-closed by construction: anything malformed, partial or out of range
 * returns null, which sends the caller down the appended-execution-page path.
 * The alternative — trusting a half-valid anchor — would stamp a signature at
 * a garbage coordinate on a statutory document, which is worse than attaching
 * a page that plainly says what it is.
 */
export function readAgreementSignatureAnchors(
  value: unknown,
): AgreementSignatureAnchors | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (
    typeof data.pageIndex !== "number"
    || !Number.isInteger(data.pageIndex)
    || data.pageIndex < 0
    || typeof data.fontSize !== "number"
    || !Number.isFinite(data.fontSize)
    || data.fontSize <= 0
  ) return null

  const rule = (raw: unknown): AgreementRuleAnchor | null => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const r = raw as Record<string, unknown>
    const num = (key: string) =>
      typeof r[key] === "number" && Number.isFinite(r[key]) ? r[key] as number : null
    const signatureX = num("signatureX")
    const signatureWidth = num("signatureWidth")
    const dateX = num("dateX")
    const dateWidth = num("dateWidth")
    const baselineY = num("baselineY")
    if (
      signatureX === null || signatureWidth === null
      || dateX === null || dateWidth === null || baselineY === null
      // A rule narrower than this cannot hold a legible signature: an image
      // would scale to a hairline and a typed name would be clamped to the 5pt
      // floor and overrun the date column. Both look UNSIGNED on the page.
      || signatureWidth < MIN_RULE_WIDTH || dateWidth < MIN_RULE_WIDTH
      || signatureX < 0 || dateX < 0 || baselineY < 0
      // Upper bounds matter as much as lower ones. A baselineY past the page
      // top draws the signature off-page, producing an artifact that looks
      // exactly as unsigned as before while the audit records "stamped".
      // The mark sits ABOVE the baseline and an image is up to MAX_SIGNATURE_HEIGHT
      // tall, so a baseline merely inside the page is not enough — the whole
      // stamp has to fit, or the artifact renders visually unsigned while the
      // audit records "stamped".
      || baselineY > A4_HEIGHT - MARGIN - MAX_SIGNATURE_HEIGHT
      || signatureX + signatureWidth > A4_WIDTH
      || dateX + dateWidth > A4_WIDTH
    ) return null
    return { signatureX, signatureWidth, dateX, dateWidth, baselineY }
  }

  const consumer = rule(data.consumer)
  const provider = rule(data.provider)
  if (!consumer || !provider) return null
  return { pageIndex: data.pageIndex, fontSize: data.fontSize, consumer, provider }
}

/**
 * Stamp both signatures onto the stored agreement.
 *
 * `anchors` come from the render that produced `agreementBytes`. When they are
 * absent the signatures cannot be placed on the original rules — the signature
 * block flows after a variable-length repayment schedule, so its position
 * cannot be guessed — and an execution page is appended instead. That is the
 * path for agreements generated before anchors were recorded, and for a
 * returned paper packet, whose consumer signature exists only as pixels inside
 * the scan and so has nothing to stamp.
 */
export async function stampExecutedAgreement(args: {
  agreementBytes: Buffer
  anchors: AgreementSignatureAnchors | null
  execution: AgreementExecution
  /** Prefix of pasqEvidenceSha256 — the same marker the agreement's own pages
   *  carry, so an appended page reads as part of the same ceremony. */
  ceremonyMarker?: string
  /** Required for the appended-page path (refused without it); unused when
   *  stamping, because the body page already carries every identifier. */
  identity?: ExecutedAgreementIdentity
}): Promise<ExecutedAgreementResult> {
  const { agreementBytes, anchors, execution, ceremonyMarker, identity } = args
  if (!Number.isFinite(execution.consumerSignedAt.getTime())) {
    throw new Error("Executed agreement requires an exact consumer signing time")
  }
  if (!Number.isFinite(execution.countersignedAt.getTime())) {
    throw new Error("Executed agreement requires an exact countersignature time")
  }
  if (execution.consumerSignature.trim().length === 0) {
    throw new Error("Executed agreement requires a consumer signature artefact")
  }
  if (execution.providerSignature.trim().length === 0) {
    throw new Error("Executed agreement requires a provider signature artefact")
  }
  if (execution.providerName.trim().length === 0) {
    throw new Error("Executed agreement requires the countersigning representative's name")
  }

  const doc = await PDFDocument.load(agreementBytes)
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique)

  const pages = doc.getPages()
  const target = anchors && anchors.pageIndex >= 0 && anchors.pageIndex < pages.length
    ? pages[anchors.pageIndex]
    : null

  // A returned paper packet has no drawable consumer signature — only a
  // reference to the scan that holds it. Stamping the original rules would
  // print that reference where the signature belongs, so this takes the
  // execution page instead, which states plainly what it records.
  const consumerIsPacketReference = isReturnedPacketReference(execution.consumerSignature)

  if (anchors && target && !consumerIsPacketReference) {
    const consumerSignatureRendered = await stampOnRule(doc, target, anchors.consumer, {
      artefact: execution.consumerSignature,
      at: execution.consumerSignedAt,
      fonts: { regular, italic },
    })
    const providerSignatureRendered = await stampOnRule(doc, target, anchors.provider, {
      artefact: execution.providerSignature,
      at: execution.countersignedAt,
      fonts: { regular, italic },
    })
    // Name the countersigning representative on the page itself. The rule only
    // carries a mark; who made it is part of the statutory record.
    drawText(
      target,
      winAnsiSafe(`Countersigned for the credit provider by ${execution.providerName}.`),
      MARGIN + 4,
      anchors.provider.baselineY - 14,
      italic,
      8,
      GRAY,
    )
    return {
      bytes: Buffer.from(await doc.save()),
      method: "stamped",
      consumerSignatureRendered,
      providerSignatureRendered,
    }
  }

  const appended = await appendExecutionPage(
    doc, { regular, bold, italic }, execution, ceremonyMarker, identity,
  )
  return {
    bytes: Buffer.from(await doc.save()),
    method: "execution_page",
    ...appended,
  }
}

/** Draw one signature artefact and its date onto an existing blank rule.
 *
 *  Everything is placed ABOVE the rule's baseline so the printed underscores
 *  remain visible underneath — a mark written on the line, which is what a
 *  signed page is supposed to look like. */
async function stampOnRule(
  doc: PDFDocument,
  page: PDFPage,
  anchor: AgreementRuleAnchor,
  args: {
    artefact: string
    at: Date
    fonts: { regular: PDFFont; italic: PDFFont }
  },
): Promise<boolean> {
  const { artefact, at, fonts } = args
  const SIT_ABOVE_RULE = 3
  const y = anchor.baselineY + SIT_ABOVE_RULE

  /** Draw a note in place of a signature, sized to stay inside the rule. */
  const note = (text: string) => {
    drawText(
      page, text, anchor.signatureX, y, fonts.italic,
      fitTextSize(text, fonts.italic, 9, anchor.signatureWidth), DARK,
    )
  }

  let rendered = false
  if (isReturnedPacketReference(artefact)) {
    // Never draw the token itself — see RETURNED_PACKET_SENTINEL_PREFIX.
    note("[signed on the returned packet]")
  } else if (artefact.startsWith(PNG_DATA_URL_PREFIX)) {
    try {
      const image = await doc.embedPng(
        Buffer.from(artefact.slice(PNG_DATA_URL_PREFIX.length), "base64"),
      )
      const scale = Math.min(
        anchor.signatureWidth / image.width,
        MAX_SIGNATURE_HEIGHT / image.height,
      )
      page.drawImage(image, {
        x: anchor.signatureX,
        y,
        width: image.width * scale,
        height: image.height * scale,
      })
      rendered = true
    } catch {
      // A corrupt artefact must not silently produce a page that looks
      // UNSIGNED. Record that a signature is held instead of drawing nothing.
      note("[signature on record]")
    }
  } else {
    // A typed signature is drawn at whatever size keeps it inside its rule, so
    // a long name cannot overrun into the date column.
    const safe = sanitiseForWinAnsi(artefact)
    try {
      drawText(
        page, safe.text, anchor.signatureX, y, fonts.italic,
        fitTextSize(safe.text, fonts.italic, 11, anchor.signatureWidth), DARK,
      )
      // A rule bearing only replacement marks evidences nothing, so it does
      // not count as a rendered signature no matter that ink reached the page.
      rendered = safe.anyOriginalKept
    } catch {
      // pdf-lib's StandardFonts are WinAnsi (CP1252) and THROW on anything
      // outside it — a diacritic or a click-language character in a typed name
      // is enough. Losing the whole countersignature to a 500 over an
      // unrenderable glyph would be far worse than recording that the
      // signature is held: the evidence lives in the database either way.
      note("[signature on record]")
    }
  }

  const date = formatDatePdf(at)
  drawText(
    page,
    date,
    anchor.dateX,
    y,
    fonts.regular,
    fitTextSize(date, fonts.regular, 9, anchor.dateWidth),
    DARK,
  )
  return rendered
}

/**
 * pdf-lib's StandardFonts encode WinAnsi (CP1252) and **throw** on anything
 * outside it — `WinAnsi cannot encode "ǁ" (0x01c1)`. A typed signature, a
 * consumer's name or a staff member's name is free text, and the click letters
 * ǀ ǁ ǂ ǃ are ordinary in South African names, so this is reachable on a live
 * signing path rather than theoretical.
 *
 * Losing the whole countersignature to a 500 over one unrenderable glyph is far
 * worse than substituting it, so each character is kept if CP1252 can encode
 * it, otherwise decomposed (é stays é, ā becomes a) and only replaced with "?"
 * when nothing encodable remains. The exact value is preserved in the database
 * and the audit log regardless of what the page can draw.
 */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"

function winAnsiEncodable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x20 && code <= 0x7e)
    || (code >= 0xa0 && code <= 0xff)
    || WIN_ANSI_EXTRA.includes(ch)
}

export function winAnsiSafe(text: string): string {
  return sanitiseForWinAnsi(text).text
}

/**
 * Sanitised text plus whether ANY of the original survived.
 *
 * A name in a non-Latin script sanitises to nothing but replacement marks —
 * "李明" becomes "??" — and a signature rule bearing "??" evidences nothing. The
 * caller needs to know that, so the audit trail can say the signature was not
 * rendered instead of claiming it was.
 */
function sanitiseForWinAnsi(text: string): { text: string; anyOriginalKept: boolean } {
  let out = ""
  let kept = false
  for (const ch of text) {
    if (winAnsiEncodable(ch)) {
      out += ch
      if (ch.trim().length > 0) kept = true
      continue
    }
    // Strip combining marks so a decomposable letter keeps its base form.
    const decomposed = [...ch.normalize("NFKD")].filter(winAnsiEncodable).join("")
    if (decomposed.length > 0) {
      out += decomposed
      if (decomposed.trim().length > 0) kept = true
    } else {
      out += "?"
    }
  }
  return { text: out, anyOriginalKept: kept }
}

/** Largest size <= `preferred` at which `text` fits `maxWidth`, floored so it
 *  never becomes unreadable. */
function fitTextSize(text: string, font: PDFFont, preferred: number, maxWidth: number): number {
  let size = preferred
  while (size > 5 && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.5
  return size
}

/**
 * Append a page carrying both signatures.
 *
 * Used when the original rules cannot be located. The page states that it forms
 * part of the agreement it is attached to, and its footer is deliberately NOT
 * "Page N of M": the body pages already carry their own totals, and adding a
 * page would otherwise produce the page-count mismatch the renderer guards
 * against.
 */
async function appendExecutionPage(
  doc: PDFDocument,
  fonts: { regular: PDFFont; bold: PDFFont; italic: PDFFont },
  execution: AgreementExecution,
  ceremonyMarker?: string,
  identity?: ExecutedAgreementIdentity,
): Promise<{ consumerSignatureRendered: boolean; providerSignatureRendered: boolean }> {
  // An execution page naming no credit provider is not one this may emit:
  // refused before the page exists.
  if (!identity) throw new LenderIdentityError(["legalName", "ncrNumber"])
  const lender = requireLenderIdentityFields(identity.lender, ["legalName", "ncrNumber"])
  const page = doc.addPage([A4_WIDTH, A4_HEIGHT])
  let y = A4_HEIGHT - MARGIN - 30

  // LEGAL_WORDING_BEGIN — execution page for a credit agreement whose signature
  // rules cannot be located (agreements generated before anchors were recorded,
  // and returned paper packets).
  //
  // APPROVED 2026-08-05 by legal, relayed by Hein in-session. The approval
  // covers BOTH executed variants as rendered on that date: signatures stamped
  // onto the original rules, and this appended execution page carrying the
  // credit provider's registered name and NCR number, the consumer's name and
  // ID number, and the agreement reference. Re-render with
  // scripts/ops/render-executed-agreement-review.ts before changing any of it.
  //
  // Do NOT edit this wording without a FRESH review — the approval attaches to
  // the rendered document, not to the idea of one.
  const EXECUTION_PAGE_TITLE = "EXECUTION PAGE"
  const EXECUTION_PAGE_STATEMENT =
    "This page forms part of the credit agreement to which it is attached and records its signature."
  // LEGAL_WORDING_END

  drawText(page, EXECUTION_PAGE_TITLE, MARGIN, y, fonts.bold, 16, DARK)
  y -= 24
  drawText(
    page,
    EXECUTION_PAGE_STATEMENT,
    MARGIN,
    y,
    fonts.regular,
    9,
    DARK,
  )
  y -= 20

  // A page that can be separated from the document must say what it belongs to.
  // The body pages carry the provider's statutory identity and the consumer's;
  // without these an execution page found on its own is attributable to no
  // agreement and no person, and the ceremony marker is optional (it is absent
  // whenever pasqEvidenceSha256 is).
  for (const line of [
    `Credit provider: ${lender.legalName} (NCR reg. no. ${lender.ncrNumber})`,
    `Consumer: ${identity.clientName} (ID ${identity.clientIdNumber})`,
    `Agreement reference: ${identity.applicationReference}`,
  ]) {
    drawText(page, winAnsiSafe(line), MARGIN, y, fonts.regular, 9, DARK)
    y -= 14
  }
  y -= 32

  const BOX_X = MARGIN + 170
  const BOX_WIDTH = 220
  const rule = async (label: string, artefact: string, at: Date) => {
    drawText(page, label, MARGIN, y, fonts.regular, 9, DARK)
    // A drawn signature must actually be DRAWN here. This is the path that
    // serves agreements generated before anchors existed, whose consumer
    // signature is a portal PNG — the very case this change exists to fix — so
    // falling back to a text placeholder would defeat it.
    const drawn = await stampOnRule(
      doc,
      page,
      {
        signatureX: BOX_X,
        signatureWidth: BOX_WIDTH,
        dateX: BOX_X + BOX_WIDTH + 44,
        dateWidth: 90,
        baselineY: y,
      },
      { artefact, at, fonts },
    )
    page.drawLine({
      start: { x: BOX_X, y: y - 4 },
      end: { x: BOX_X + BOX_WIDTH, y: y - 4 },
      thickness: 0.75,
      color: GRAY,
    })
    drawText(page, "Date:", BOX_X + BOX_WIDTH + 14, y, fonts.regular, 9, DARK)
    y -= 52
    return drawn
  }

  const consumerSignatureRendered =
    await rule("Consumer Signature:", execution.consumerSignature, execution.consumerSignedAt)
  const providerSignatureRendered =
    await rule("Credit Provider:", execution.providerSignature, execution.countersignedAt)

  drawText(
    page,
    winAnsiSafe(`Countersigned for the credit provider by ${execution.providerName}.`),
    MARGIN,
    y,
    fonts.italic,
    8,
    GRAY,
  )

  const footer = ceremonyMarker
    ? `Execution page · Ref ${ceremonyMarker}`
    : "Execution page"
  drawText(
    page,
    footer,
    MARGIN,
    MARGIN - 10,
    fonts.regular,
    7,
    GRAY,
  )
  drawText(
    page,
    "This agreement is governed by the National Credit Act 34 of 2005",
    A4_WIDTH - MARGIN - fonts.italic.widthOfTextAtSize(
      "This agreement is governed by the National Credit Act 34 of 2005",
      7,
    ),
    MARGIN - 10,
    fonts.italic,
    7,
    GRAY,
  )
  return { consumerSignatureRendered, providerSignatureRendered }
}

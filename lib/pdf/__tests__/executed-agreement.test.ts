// lib/pdf/__tests__/executed-agreement.test.ts
import { describe, it, expect } from "vitest"
import { inflateSync } from "zlib"
import { PDFDocument } from "pdf-lib"
import { generateCreditAgreementPdfWithAnchors } from "../creditAgreement"
import { stampExecutedAgreement, readAgreementSignatureAnchors } from "../executed-agreement"
import { LenderIdentityError } from "@/lib/config/identity-schema"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

// ── Fixture ──────────────────────────────────────────────────────────────────

const baseInput = {
  variant: "agreement" as const,
  lender: ACME_LENDER,
  client: {
    firstName: "Thandeka",
    lastName: "Mokoena",
    idNumber: "8501015000080",
    addressLine1: "45 Oak Avenue",
    city: "Soweto",
  },
  application: {
    reference: "APP-001",
    agreementType: "Short-term Credit",
    appliedTermDays: 30,
  },
  calc: {
    principal: 500000,
    initiationFee: 57500,
    totalInterest: 25000,
    totalRepayable: 582500,
    disbursementAmount: 500000,
    monthlyInstalment: 582500,
    serviceFees: 6900,
    schedule: [
      {
        installmentNo: 1,
        dueDate: new Date("2026-06-01"),
        openingBalance: 500000,
        principalDue: 500000,
        interestDue: 25000,
        feesDue: 6900,
        totalDue: 582500,
        closingBalance: 0,
      },
    ],
  },
  product: { interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6900 },
  startDate: new Date("2026-05-15"),
  maturityDate: new Date("2026-06-14"),
  quotePresentedAt: new Date("2026-05-15T08:00:00.000Z"),
  quoteValidUntilDate: "2026-05-22",
}

/** A real 1x1 PNG — embedPng rejects anything that is not genuinely a PNG, so
 *  a fake string would exercise only the corrupt-artefact fallback. */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const identity = {
  lender: { legalName: ACME_LENDER.legalName, ncrNumber: ACME_LENDER.ncrNumber },
  clientName: "Thandeka Mokoena",
  clientIdNumber: "8501015000080",
  applicationReference: "APP-TEST-0142",
}

const execution = {
  consumerSignature: PNG_1PX,
  consumerSignedAt: new Date("2026-05-20T09:30:00.000Z"),
  providerSignature: "Nomsa Dlamini",
  providerName: "Nomsa Dlamini",
  countersignedAt: new Date("2026-05-21T14:00:00.000Z"),
}

// ── PDF inspection ───────────────────────────────────────────────────────────

function rawPdfStreams(buf: Buffer): string[] {
  const parts: string[] = []
  let i = 0
  while (i < buf.length - 6) {
    if (buf.subarray(i, i + 6).toString("ascii") === "stream") {
      let start = i + 6
      while (start < buf.length && (buf[start] === 13 || buf[start] === 10)) start++
      const end = buf.indexOf(Buffer.from("endstream"), start)
      if (end > start && end - start < 200_000) {
        const data = buf.subarray(start, end)
        try {
          parts.push(inflateSync(data).toString("latin1"))
        } catch {
          parts.push(data.toString("latin1"))
        }
      }
      i = end > i ? end + 9 : i + 1
    } else {
      i++
    }
  }
  return parts
}

/**
 * Count image DRAW operators, not embedded image objects.
 *
 * pdf-lib's embedPng() creates the XObject whether or not anything draws it, so
 * asserting "a PNG is embedded" passes on correct AND on broken code. Only a
 * `Do` operator in a content stream proves the signature is visible on a page.
 * pdf-lib names images with a hyphenated numeric suffix (/Image-123 Do), so the
 * hyphen must be part of the pattern.
 */
function imageDrawCount(pdf: Buffer): number {
  return rawPdfStreams(pdf)
    .join("\n")
    .match(/\/Image-?\d+\s+Do/g)?.length ?? 0
}

const hex = (s: string) => Buffer.from(s, "ascii").toString("hex").toUpperCase()

function contentText(pdf: Buffer): string {
  return rawPdfStreams(pdf).join("\n")
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("stampExecutedAgreement — the signature reaches the page", () => {
  it("draws the consumer's signature image, which the unsigned document does not", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const unsignedDraws = imageDrawCount(bytes)

    const { bytes: executed, method } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution,
    })

    expect(method).toBe("stamped")
    // Exactly one MORE image is drawn than on the unsigned document. The
    // provider signature here is typed, so it adds text, not an image.
    expect(imageDrawCount(executed)).toBe(unsignedDraws + 1)
  })

  it("draws TWO signature images when both parties signed by drawing", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const unsignedDraws = imageDrawCount(bytes)

    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: { ...execution, providerSignature: PNG_1PX },
    })

    expect(imageDrawCount(executed)).toBe(unsignedDraws + 2)
  })

  it("writes the typed provider signature and the countersigning representative onto the page", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution,
    })

    const text = contentText(executed)
    expect(text).toContain(hex("Nomsa Dlamini"))
    expect(text).toContain(hex("Countersigned for the credit provider by Nomsa Dlamini."))
    // ...and the unsigned document carried none of it.
    expect(contentText(bytes)).not.toContain(hex("Countersigned for the credit provider by"))
  })

  it("preserves the signed document's own page content — the artifact IS what was signed", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution,
    })

    // The blank rules are still there, with the signatures written on them, and
    // every statutory heading survives the stamp.
    const text = contentText(executed)
    for (const phrase of [
      "CREDIT AGREEMENT",
      "In terms of the National Credit Act 34 of 2005",
      "Consumer Signature:",
      "Credit Provider Representative:",
    ]) {
      expect(text).toContain(hex(phrase))
    }
    // No page was added or lost.
    const before = await PDFDocument.load(bytes)
    const after = await PDFDocument.load(executed)
    expect(after.getPageCount()).toBe(before.getPageCount())
  })

  it("places each signature ON its own rule, at the coordinates the anchors report", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    expect(signatureAnchors).not.toBeNull()
    const anchors = signatureAnchors!

    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors,
      execution: { ...execution, providerSignature: PNG_1PX },
    })

    // pdf-lib emits a chain for each drawn image:
    //   q / 1 0 0 1 X Y cm / 1 0 0 1 0 0 cm / w 0 0 h 0 0 cm / … / /Image-N Do
    // The FIRST cm is the placement. Reading it back proves WHERE the signature
    // landed — a page-identity check would still pass with the signature in the
    // wrong place, and a misplaced signature on a statutory document is the
    // failure that actually matters.
    const text = contentText(executed)
    const placements = [...text.matchAll(
      /1 0 0 1 ([\d.]+) ([\d.]+) cm[\s\S]{0,160}?\/Image-?\d+\s+Do/g,
    )].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))

    for (const rule of [anchors.consumer, anchors.provider]) {
      const hit = placements.find(
        (p) => Math.abs(p.x - rule.signatureX) < 0.01 && p.y > rule.baselineY,
      )
      expect(hit, `no signature drawn on the rule at y=${rule.baselineY}`).toBeDefined()
      // Sits just above the printed underscores, not through or below them.
      expect(hit!.y - rule.baselineY).toBeLessThanOrEqual(6)
      // ...and the date is written on the date rule, not over the signature.
      expect(text).toContain(`1 0 0 1 ${rule.dateX} ${hit!.y} Tm`)
    }
  })
})

describe("stampExecutedAgreement — anchorless fallback", () => {
  it("appends an execution page carrying BOTH signatures when anchors are absent", async () => {
    const { bytes } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const before = await PDFDocument.load(bytes)

    const { bytes: executed, method } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: null,
      execution: { ...execution, providerSignature: PNG_1PX },
      identity,
      ceremonyMarker: "4af7707c7ba1",
    })

    expect(method).toBe("execution_page")
    const after = await PDFDocument.load(executed)
    expect(after.getPageCount()).toBe(before.getPageCount() + 1)

    // Both drawn signatures are actually drawn on it — this is the path that
    // serves agreements generated before anchors existed, whose consumer
    // signature is a portal PNG.
    expect(imageDrawCount(executed)).toBe(imageDrawCount(bytes) + 2)

    const text = contentText(executed)
    expect(text).toContain(hex("EXECUTION PAGE"))
    expect(text).toContain(hex("4af7707c7ba1"))
    expect(text).toContain(hex("Countersigned for the credit provider by Nomsa Dlamini."))
  })

  it("falls back to the execution page when the anchors point off the end of the document", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const before = await PDFDocument.load(bytes)

    const { method } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: { ...signatureAnchors!, pageIndex: 99 },
      execution,
      identity,
    })

    // Silently stamping page 0 would put a signature in the middle of a
    // statutory document.
    expect(method).toBe("execution_page")
    expect(before.getPageCount()).toBeGreaterThan(0)
  })
})

describe("stampExecutedAgreement — execution page requires lender identity", () => {
  it("throws LenderIdentityError instead of rendering the page without identity", async () => {
    const { bytes } = await generateCreditAgreementPdfWithAnchors(baseInput)
    await expect(
      stampExecutedAgreement({ agreementBytes: bytes, anchors: null, execution }),
    ).rejects.toBeInstanceOf(LenderIdentityError)
    await expect(
      stampExecutedAgreement({
        agreementBytes: bytes,
        anchors: null,
        execution,
        identity: { ...identity, lender: { ...identity.lender, ncrNumber: "bad" } },
      }),
    ).rejects.toBeInstanceOf(LenderIdentityError)
  })
})

describe("stampExecutedAgreement — refuses incomplete execution evidence", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a missing consumer signature", { consumerSignature: "   " }],
    ["a missing provider signature", { providerSignature: "" }],
    ["a missing representative name", { providerName: "  " }],
    ["an invalid consumer signing time", { consumerSignedAt: new Date("nope") }],
    ["an invalid countersignature time", { countersignedAt: new Date("nope") }],
  ]

  for (const [label, override] of cases) {
    it(`throws on ${label}`, async () => {
      const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
      await expect(stampExecutedAgreement({
        agreementBytes: bytes,
        anchors: signatureAnchors,
        execution: { ...execution, ...override } as typeof execution,
      })).rejects.toThrow()
    })
  }

  it("records that a signature is held rather than rendering a page that looks unsigned", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: { ...execution, consumerSignature: "data:image/png;base64,bm90LWEtcG5n" },
    })

    expect(contentText(executed)).toContain(hex("[signature on record]"))
    // A corrupt artefact must not silently draw nothing.
    expect(imageDrawCount(executed)).toBe(imageDrawCount(bytes))
  })
})

// ── The anchor validator ─────────────────────────────────────────────────────
//
// This is the ONLY control between a corrupt or stale manifest and a signature
// drawn at an arbitrary coordinate on a statutory document. It had no direct
// tests, and the route tests mock it to a pass-through, so mutating it to a
// bare cast left the whole suite green.
describe("readAgreementSignatureAnchors — fails closed", () => {
  const valid = {
    pageIndex: 3,
    fontSize: 9,
    consumer: { signatureX: 131, signatureWidth: 155, dateX: 314, dateWidth: 75, baselineY: 603 },
    provider: { signatureX: 171, signatureWidth: 100, dateX: 299, dateWidth: 75, baselineY: 531 },
  }

  it("accepts a well-formed anchor set", () => {
    expect(readAgreementSignatureAnchors(valid)).toEqual(valid)
  })

  const rejected: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "anchors"],
    ["an array", [valid]],
    ["a missing consumer rule", { ...valid, consumer: undefined }],
    ["a missing provider rule", { ...valid, provider: undefined }],
    ["a non-integer pageIndex", { ...valid, pageIndex: 1.5 }],
    ["a negative pageIndex", { ...valid, pageIndex: -1 }],
    ["a zero fontSize", { ...valid, fontSize: 0 }],
    ["a NaN coordinate", { ...valid, consumer: { ...valid.consumer, baselineY: Number.NaN } }],
    ["a string coordinate", { ...valid, consumer: { ...valid.consumer, signatureX: "131" } }],
    ["a negative baseline", { ...valid, consumer: { ...valid.consumer, baselineY: -1 } }],
    // Off the TOP of an A4 page: the signature would be drawn where nothing is
    // visible, leaving an artifact that looks exactly as unsigned as before
    // while the audit trail records "stamped".
    ["a baseline past the page top", { ...valid, consumer: { ...valid.consumer, baselineY: 900 } }],
    ["a rule running off the right edge", { ...valid, provider: { ...valid.provider, signatureX: 560 } }],
    ["a date rule running off the right edge", { ...valid, provider: { ...valid.provider, dateX: 560 } }],
    // Too narrow to hold anything legible — an image scales to a hairline.
    ["a hairline signature rule", { ...valid, consumer: { ...valid.consumer, signatureWidth: 0.001 } }],
    ["a hairline date rule", { ...valid, consumer: { ...valid.consumer, dateWidth: 0.001 } }],
  ]

  for (const [label, input] of rejected) {
    it(`rejects ${label}`, () => {
      expect(readAgreementSignatureAnchors(input)).toBeNull()
    })
  }
})

describe("winAnsiSafe — a name that sanitises to nothing is not a signature", () => {
  it("reports a non-Latin script as NOT rendered", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const result = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      // Sanitises to "??" — ink reaches the page but evidences nothing, so
      // claiming the signature was rendered would make the audit trail lie.
      execution: { ...execution, consumerSignature: "李明" },
      identity,
    })
    expect(result.consumerSignatureRendered).toBe(false)
    expect(result.providerSignatureRendered).toBe(true)
  })

  it("still counts a name that keeps any of its original characters", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const result = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: { ...execution, consumerSignature: "Nǁoahin Mokoena" },
      identity,
    })
    expect(result.consumerSignatureRendered).toBe(true)
  })
})

describe("anchor bounds — the whole stamp must fit, not just the baseline", () => {
  const valid = {
    pageIndex: 3,
    fontSize: 9,
    consumer: { signatureX: 131, signatureWidth: 155, dateX: 314, dateWidth: 75, baselineY: 603 },
    provider: { signatureX: 171, signatureWidth: 100, dateX: 299, dateWidth: 75, baselineY: 531 },
  }

  it("rejects a baseline inside the page whose stamp would still render off it", () => {
    // 838 is below A4_HEIGHT (841.89) but the mark sits above the baseline and
    // an image is up to 34pt tall, so it would render entirely off-page —
    // producing method "stamped" on a visually unsigned document.
    expect(readAgreementSignatureAnchors({
      ...valid,
      consumer: { ...valid.consumer, baselineY: 838 },
    })).toBeNull()
  })

  it("still accepts the real signature-block geometry", async () => {
    const { signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    // The bound must not reject what the renderer actually produces.
    expect(readAgreementSignatureAnchors(signatureAnchors)).not.toBeNull()
  })
})

// ── The returned paper packet ────────────────────────────────────────────────
describe("stampExecutedAgreement — a returned packet is not a signature", () => {
  // agreement/sign/route.ts stores this token in agreementSignatureData when
  // staff record a returned PAPER packet: the consumer's signature exists only
  // as pixels inside the uploaded scan.
  const SENTINEL = `signed-packet-v1:doc-abc123:${"b".repeat(64)}`

  it("never draws the packet token onto the agreement", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const { bytes: executed, method } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: { ...execution, consumerSignature: SENTINEL },
      identity,
    })

    // It must not appear anywhere in the rendered content...
    expect(contentText(executed)).not.toContain(hex(SENTINEL))
    expect(contentText(executed)).not.toContain(hex("signed-packet-v1:"))
    // ...and the document says what it actually records.
    expect(contentText(executed)).toContain(hex("[signed on the returned packet]"))
    // The original rules cannot be stamped when there is nothing to stamp.
    expect(method).toBe("execution_page")
  })

  it("reports that the consumer signature was not rendered", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const result = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: { ...execution, consumerSignature: SENTINEL },
      identity,
    })
    expect(result.consumerSignatureRendered).toBe(false)
    // The provider's typed signature still renders normally.
    expect(result.providerSignatureRendered).toBe(true)
  })
})

// ── Text that pdf-lib's StandardFonts cannot encode ──────────────────────────
describe("stampExecutedAgreement — unencodable characters do not throw", () => {
  // pdf-lib throws `WinAnsi cannot encode "ǁ" (0x01c1)`. The click letters
  // ǀ ǁ ǂ ǃ are ordinary in South African names, so this is a live path.
  it("renders a typed signature containing a click letter instead of throwing", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const result = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: {
        ...execution,
        consumerSignature: "Nǁoahin Mokoena",
        providerSignature: "Nomsa Dlamini",
        providerName: "Nǂamce Dlamini",
      },
      identity,
    })
    expect(result.method).toBe("stamped")
    // The name still reaches the page, with only the unencodable glyph replaced.
    expect(contentText(result.bytes)).toContain(hex("N?oahin Mokoena"))
  })

  it("keeps a Latin-1 diacritic exactly as written", async () => {
    const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: signatureAnchors,
      execution: { ...execution, consumerSignature: "José Züber" },
      identity,
    })
    expect(contentText(executed)).toContain(hex("José Züber"))
  })
})

// ── The appended page must be attributable on its own ────────────────────────
describe("execution page — identifies the parties", () => {
  it("names the credit provider, its NCR number, the consumer and the reference", async () => {
    const { bytes } = await generateCreditAgreementPdfWithAnchors(baseInput)
    const { bytes: executed } = await stampExecutedAgreement({
      agreementBytes: bytes,
      anchors: null,
      execution,
      identity,
      ceremonyMarker: "4af7707c7ba1",
    })
    const text = contentText(executed)
    // A page that can be separated from the document must say what it belongs
    // to; the ceremony marker is optional and absent whenever the PASQ evidence
    // digest is, so it cannot be the only identifier.
    expect(text).toContain(hex("Acme Lending (Pty) Ltd"))
    expect(text).toContain(hex("NCRCP99999"))
    expect(text).toContain(hex("Thandeka Mokoena"))
    expect(text).toContain(hex("8501015000080"))
    expect(text).toContain(hex("APP-TEST-0142"))
  })
})

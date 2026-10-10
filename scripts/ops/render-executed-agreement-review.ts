/**
 * Renders the EXECUTED credit agreement to disk so the legal reviewer can
 * eyeball the actual signed document before it ships.
 *
 * The unsigned agreement's render is pinned in
 * lib/pdf/__tests__/creditAgreement.test.ts and is UNCHANGED by this work — the
 * pin still passes. What is new is the artifact produced at countersignature:
 * the stored agreement with both signatures stamped onto its existing signature
 * rules. That document has never been reviewed, so it needs its own sign-off.
 *
 *   npx tsx scripts/ops/render-executed-agreement-review.ts <output-dir>
 *
 * Writes three PDFs:
 *   agreement-UNSIGNED.pdf          what the consumer is shown and signs
 *   agreement-EXECUTED-stamped.pdf  the normal path — signatures on the rules
 *   agreement-EXECUTED-page.pdf     the fallback for agreements generated
 *                                   before anchors were recorded, which is
 *                                   every agreement live today
 *
 * The signature page is page 4 in this fixture; the execution page is page 5 of
 * the fallback variant.
 *
 * Also writes agreement-60-UNSIGNED.pdf and agreement-60-EXECUTED-stamped.pdf:
 * a 60-instalment schedule continues onto a second schedule page, which moves
 * the signature page to page 5.
 */
import { writeFileSync, mkdirSync } from "node:fs"
import { deflateSync } from "node:zlib"
import { generateCreditAgreementPdfWithAnchors } from "../../lib/pdf/creditAgreement"
import { stampExecutedAgreement } from "../../lib/pdf/executed-agreement"
import { ACME_LENDER } from "../../lib/config/__fixtures__/lender-identity"
import { calculateLoan } from "../../lib/loan-calculator"
import { boundaryAgreementInput, boundaryLoanInput, boundaryStartDate } from "../nca-pdf-fingerprint"

/**
 * A drawn signature, as the portal captures one: a stroke on a transparent
 * canvas exported as a PNG data URL. Generated rather than checked in so the
 * review pack carries no real consumer's signature.
 */
function syntheticDrawnSignature(): string {
  const W = 400
  const H = 120
  const pixels = Buffer.alloc(W * H * 4, 0)
  for (let t = 0; t < 2000; t++) {
    const x = Math.floor((t / 2000) * (W - 20)) + 10
    const y = Math.floor(H / 2 + Math.sin(t / 90) * 30 + Math.sin(t / 17) * 8)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const i = ((y + dy) * W + (x + dx)) * 4
        if (i >= 0 && i + 3 < pixels.length) {
          pixels[i] = 20
          pixels[i + 1] = 30
          pixels[i + 2] = 120
          pixels[i + 3] = 255
        }
      }
    }
  }

  const raw = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0
    pixels.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
  }

  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([length, typed, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString("base64")}`
}

const baseInput = {
  variant: "agreement" as const,
  lender: ACME_LENDER,
  client: {
    firstName: "Thandeka",
    lastName: "Mokoena",
    idNumber: "8501015000080",
    addressLine1: "45 Oak Avenue",
    suburb: "Orlando West",
    city: "Soweto",
    province: "Gauteng",
    postalCode: "1804",
    phone: "0821234567",
  },
  application: {
    reference: "APP-TEST-0142",
    agreementType: "Short-term Credit",
    appliedTermDays: 90,
  },
  calc: {
    principal: 800000,
    initiationFee: 105000,
    totalInterest: 120000,
    totalRepayable: 1045700,
    disbursementAmount: 800000,
    monthlyInstalment: 348566,
    serviceFees: 20700,
    schedule: [1, 2, 3].map((n) => ({
      installmentNo: n,
      dueDate: new Date(`2026-0${5 + n}-01`),
      openingBalance: 800000 - (n - 1) * 266667,
      principalDue: 266667,
      interestDue: 40000,
      feesDue: 6900,
      totalDue: 348566,
      closingBalance: 800000 - n * 266667,
    })),
  },
  product: { interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6900 },
  startDate: new Date("2026-05-15"),
  maturityDate: new Date("2026-08-01"),
  quotePresentedAt: new Date("2026-05-15T08:00:00.000Z"),
  quoteValidUntilDate: "2026-05-22",
  initiationFeePayment: "DEFERRED" as const,
  // Same per-ceremony reference the quotation carries, so the packet reads as
  // one ceremony. A prefix of pasqEvidenceSha256, known before either render.
  ceremonyMarker: "4af7707c7ba1",
}

async function main() {
  const outDir = process.argv[2]
  if (!outDir) {
    console.error(
      "usage: npx tsx scripts/ops/render-executed-agreement-review.ts <output-dir>",
    )
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })

  const { bytes, signatureAnchors } = await generateCreditAgreementPdfWithAnchors(baseInput)
  writeFileSync(`${outDir}/agreement-UNSIGNED.pdf`, bytes)

  const execution = {
    consumerSignature: syntheticDrawnSignature(),
    consumerSignedAt: new Date("2026-05-20T09:30:00.000Z"),
    // Typed, which is what the countersign route captures today.
    providerSignature: "Nomsa Dlamini",
    providerName: "Nomsa Dlamini",
    countersignedAt: new Date("2026-05-21T14:00:00.000Z"),
  }

  const identity = {
    lender: baseInput.lender,
    clientName: `${baseInput.client.firstName} ${baseInput.client.lastName}`,
    clientIdNumber: baseInput.client.idNumber,
    applicationReference: baseInput.application.reference,
  }

  const stamped = await stampExecutedAgreement({
    agreementBytes: bytes,
    anchors: signatureAnchors,
    execution,
    ceremonyMarker: baseInput.ceremonyMarker,
    identity,
  })
  writeFileSync(`${outDir}/agreement-EXECUTED-stamped.pdf`, stamped.bytes)

  const appended = await stampExecutedAgreement({
    agreementBytes: bytes,
    anchors: null,
    execution: { ...execution, providerSignature: syntheticDrawnSignature() },
    ceremonyMarker: baseInput.ceremonyMarker,
    identity,
  })
  writeFileSync(`${outDir}/agreement-EXECUTED-page.pdf`, appended.bytes)

  const long = await generateCreditAgreementPdfWithAnchors(
    boundaryAgreementInput("agreement", calculateLoan(boundaryLoanInput(60), boundaryStartDate)),
  )
  writeFileSync(`${outDir}/agreement-60-UNSIGNED.pdf`, long.bytes)
  const longStamped = await stampExecutedAgreement({
    agreementBytes: long.bytes,
    anchors: long.signatureAnchors,
    // Signed after this fixture's quotation (22 July 2026), not the one above.
    execution: {
      ...execution,
      consumerSignedAt: new Date("2026-07-23T09:30:00.000Z"),
      countersignedAt: new Date("2026-07-24T14:00:00.000Z"),
    },
    ceremonyMarker: "0123456789ab",
    identity,
  })
  writeFileSync(`${outDir}/agreement-60-EXECUTED-stamped.pdf`, longStamped.bytes)

  console.log(`wrote 5 PDFs to ${outDir}`)
  console.log(`  stamped path : ${stamped.method}  (signature page is page 4)`)
  console.log(`  fallback path: ${appended.method}  (execution page is page 5)`)
  console.log(`  60 instalments: ${longStamped.method}  (signature page is page ${(long.signatureAnchors?.pageIndex ?? -1) + 1})`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

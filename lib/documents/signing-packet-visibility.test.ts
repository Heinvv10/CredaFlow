import { describe, expect, it } from "vitest"
import {
  SIGNING_PACKET_COMPONENT_NOTE,
  isSigningPacketComponent,
  partitionSigningPacketDocuments,
} from "./signing-packet-visibility"

const doc = (docType: string, id = docType) => ({ id, docType })

describe("signing packet visibility", () => {
  // The consumer must receive the PASQ and the credit agreement as ONE packet,
  // PASQ first — that is what the signing-packet endpoint issues and what the
  // upload gate counts pages against. Listing the two halves as ordinary
  // downloadable documents is what led staff to email a 4-page half for
  // signature and have the completed upload refused.
  it.each([
    ["FORM_20_PRE_AGREEMENT"],
    ["CREDIT_AGREEMENT"],
    // The returned signed copy: the lifecycle card serves it, so a separate
    // card for it just restores the two-similar-PDFs ambiguity.
    ["SIGNED_AGREEMENT_PACKET"],
  ])("treats %s as a packet component, not a document to send", (docType) => {
    expect(isSigningPacketComponent(docType)).toBe(true)
  })

  // The executed artifact is the whole packet plus the execution page. After
  // signature it IS the single thing anyone should download, so it must stay in
  // the main list rather than being filed away with the halves.
  it("keeps the executed agreement in the main list", () => {
    expect(isSigningPacketComponent("EXECUTED_CREDIT_AGREEMENT")).toBe(false)
  })

  it.each([
    ["ID_COPY"],
    ["BANK_STATEMENT"],
    ["PAYSLIP"],
    ["DEBIT_MANDATE"],
    ["OTHER"],
  ])("leaves %s in the main list", (docType) => {
    expect(isSigningPacketComponent(docType)).toBe(false)
  })

  it("splits a mixed folder into main documents and packet components", () => {
    const { primary, packetComponents } = partitionSigningPacketDocuments([
      doc("ID_COPY"),
      doc("FORM_20_PRE_AGREEMENT"),
      doc("BANK_STATEMENT"),
      doc("CREDIT_AGREEMENT"),
      doc("EXECUTED_CREDIT_AGREEMENT"),
    ])

    expect(primary.map((d) => d.docType)).toEqual([
      "ID_COPY",
      "BANK_STATEMENT",
      "EXECUTED_CREDIT_AGREEMENT",
    ])
    expect(packetComponents.map((d) => d.docType)).toEqual([
      "FORM_20_PRE_AGREEMENT",
      "CREDIT_AGREEMENT",
    ])
  })

  it("preserves the incoming order within each group", () => {
    const { primary, packetComponents } = partitionSigningPacketDocuments([
      doc("CREDIT_AGREEMENT", "ca-1"),
      doc("OTHER", "other-1"),
      doc("FORM_20_PRE_AGREEMENT", "pasq-1"),
      doc("OTHER", "other-2"),
    ])

    expect(primary.map((d) => d.id)).toEqual(["other-1", "other-2"])
    expect(packetComponents.map((d) => d.id)).toEqual(["ca-1", "pasq-1"])
  })

  it("handles an empty folder", () => {
    expect(partitionSigningPacketDocuments([])).toEqual({
      primary: [],
      packetComponents: [],
    })
  })

  // The note has to name the remedy. "Locked statutory evidence" reads as
  // authoritative, which is precisely why staff attached these to emails.
  it("tells the reader these cannot be signed on their own", () => {
    expect(SIGNING_PACKET_COMPONENT_NOTE).toMatch(/cannot be signed on (its|their) own/i)
    expect(SIGNING_PACKET_COMPONENT_NOTE).toMatch(/application/i)
  })

  // The note is the only thing telling a reader where the real download is.
  it("points at the lifecycle card", () => {
    expect(SIGNING_PACKET_COMPONENT_NOTE).toMatch(/signing packet card/i)
  })
})

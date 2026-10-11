import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import { isLockedStatutoryEvidence } from "./generic-action-policy"
import { DOC_TYPE_LABELS, SYSTEM_GENERATED_DOC_TYPES } from "../document-types"

/**
 * The returned signed packet is written by ONE route and read back by ANOTHER,
 * and both name its docType as a literal in a Prisma where-clause. Nothing in
 * the mocked route suites constrains that literal: reverting either side to the
 * old "OTHER" leaves all 23 sign-route tests green while every real recording
 * fails closed with signed_packet_changed, because the reader's findFirst no
 * longer matches the row the writer created.
 *
 * Without this file the whole suite passes with the writer and reader
 * disagreeing; it is the only thing standing between that mutation and a
 * release.
 */

const PACKET_DOC_TYPE = "SIGNED_AGREEMENT_PACKET"

const UPLOAD_ROUTE = "app/api/applications/[id]/signing-packet/route.ts"
const RECORD_ROUTE = "app/api/applications/[id]/agreement/sign/route.ts"

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8")
}

/** Every docType literal in a file, so a stray second type cannot hide. */
function docTypeLiterals(src: string): string[] {
  const found = [...src.matchAll(/docType:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1])
  if (found.length === 0) {
    throw new Error("no docType literals found — this test is blind, fix the parser")
  }
  return found
}

describe("returned signed packet docType", () => {
  // The writer. Creating it as anything else — OTHER most of all — puts the one
  // document carrying the consumer's signature among miscellaneous uploads.
  it("is what the upload route CREATES", () => {
    const src = source(UPLOAD_ROUTE)
    const created = /docType:\s*"([A-Z0-9_]+)",\s*\n\s*fileUrl:/.exec(src)
    expect(created, "clientDocument.create docType not found — parser is stale").toBeTruthy()
    expect(created![1]).toBe(PACKET_DOC_TYPE)
  })

  // The reader. Both of its where-clauses — the pre-transaction read and the
  // in-transaction lock — must name the same type, or recording fails closed.
  it("is what the recording route READS BACK, in every where-clause", () => {
    const literals = docTypeLiterals(source(RECORD_ROUTE))
    const packetReads = literals.filter((t) => t === PACKET_DOC_TYPE)
    expect(
      packetReads.length,
      `expected 2 ${PACKET_DOC_TYPE} where-clauses (optimistic read + transaction lock), found ${packetReads.length} in ${literals.join(", ")}`,
    ).toBe(2)
  })

  // The writer's literal and the reader's literal are the same string. Stated
  // directly rather than left to the two assertions above, because that is the
  // invariant: a rename must move both or neither.
  it("is the SAME type on both sides", () => {
    const written = /docType:\s*"([A-Z0-9_]+)",\s*\n\s*fileUrl:/.exec(source(UPLOAD_ROUTE))![1]
    const read = docTypeLiterals(source(RECORD_ROUTE))
      .filter((t) => t === written)
    expect(
      read.length,
      `the upload route writes ${written} but the recording route never reads it back`,
    ).toBeGreaterThan(0)
  })

  it("is never offered to the generic upload picker", () => {
    expect(SYSTEM_GENERATED_DOC_TYPES).toContain(PACKET_DOC_TYPE)
  })

  // It carries the consumer's actual signature, so the generic verify, extract
  // and delete paths must all refuse it. As OTHER they did not: a row could
  // reach verified=true with signatureState still returned_pending_recording,
  // a combination the recording transaction never writes.
  it("is locked statutory evidence", () => {
    expect(isLockedStatutoryEvidence(PACKET_DOC_TYPE)).toBe(true)
  })

  // The delete route enumerates types explicitly instead of calling
  // isLockedStatutoryEvidence, so adding to that set alone leaves it deletable.
  it("is named in the delete route's refusal chain", () => {
    expect(source("app/api/documents/[id]/route.ts")).toContain(PACKET_DOC_TYPE)
  })

  it("is named in the extract route's refusal chain", () => {
    expect(source("app/api/documents/[id]/extract/route.ts")).toContain(PACKET_DOC_TYPE)
  })

  it("is named in the verify route's refusal chain", () => {
    expect(source("app/api/clients/[id]/documents/[docId]/verify/route.ts"))
      .toContain(PACKET_DOC_TYPE)
  })

  // The lifecycle endpoint reads the packet back to decide the card's state.
  // Drop or rename this filter and the card silently reports "awaiting
  // signature" for an application whose packet HAS been returned — a false
  // statement on the surface staff read before disbursing.
  it("is what the lifecycle endpoint reads to build the card", () => {
    expect(source("app/api/clients/[id]/signing-packets/route.ts"))
      .toContain(PACKET_DOC_TYPE)
  })

  // The upload route sets LoanApplication.signedPacketDocumentId and may
  // re-point it freely while agreementSignedAt is NULL. Recording is where that
  // must stop: the recording transaction has to claim the binding for the packet
  // it actually recorded, and release it when it records none.
  //
  // Without this, the pointer outlives the truth in two ways that need no
  // exotic timing: two uploads then a record of the FIRST, or an upload followed
  // by an IN-APP signature. Either leaves an unsigned PDF bound to a signed
  // application, which the documents folder then offers as signature evidence.
  describe("the recording route reconciles the application binding", () => {
    const src = () => source(RECORD_ROUTE)

    it("writes signedPacketDocumentId inside the signing transaction", () => {
      expect(src()).toMatch(/signedPacketDocumentId:\s*recordsReturnedPacket/)
    })

    it("writes the digest alongside it", () => {
      expect(src()).toMatch(/signedPacketDocumentSha256:\s*recordsReturnedPacket/)
    })

    // The release branch is the half that covers an in-app signature. A fix that
    // only sets the pointer when a packet IS recorded leaves the stale one in
    // place for every consumer who signs in the portal after a staff upload.
    it("releases the binding when the signature records no packet", () => {
      const both = [
        ...src().matchAll(
          /signedPacketDocument(?:Id|Sha256):\s*recordsReturnedPacket\s*\?[\s\S]{0,120}?:\s*null/g,
        ),
      ]
      expect(
        both.length,
        "expected BOTH signedPacketDocumentId and signedPacketDocumentSha256 to fall back to null when recordsReturnedPacket is false",
      ).toBe(2)
    })
  })

  // Tearing down an agreement lifecycle must retire the returned-packet binding
  // with it. These blocks already null 20+ sibling fields including
  // agreementExecutedDocumentId; a binding left behind outlives the truth it
  // recorded and the card surfaces it again as soon as a new agreement is
  // generated. Counted, not merely grepped: there are three teardown sites
  // (return_to_review, return_to_draft, approve) and missing any one of them
  // leaves that path stale.
  it("is retired by every agreement-lifecycle teardown in the decide route", () => {
    const src = source("app/api/applications/[id]/decide/route.ts")
    const executed = [...src.matchAll(/agreementExecutedDocumentSha256:\s*null,/g)].length
    const packet = [...src.matchAll(/signedPacketDocumentSha256:\s*null,/g)].length
    expect(executed, "teardown-site count changed — this test is stale").toBe(3)
    expect(
      packet,
      `the returned-packet binding is cleared in ${packet} of ${executed} teardown blocks`,
    ).toBe(executed)
  })

  it("renders a label wherever it is listed", () => {
    expect(DOC_TYPE_LABELS[PACKET_DOC_TYPE]).toBeTruthy()
    expect(DOC_TYPE_LABELS[PACKET_DOC_TYPE]).not.toBe("Other")
  })

  // The DocType enum value was declared before any code used it.
  // A docType the schema does not declare is a runtime Prisma error, not a
  // type error, because these are string literals in where-clauses.
  it("is declared in the Prisma schema", () => {
    const schema = source("prisma/schema.prisma")
    const docTypeEnum = /enum DocType \{([\s\S]*?)\n\}/.exec(schema)
    expect(docTypeEnum, "DocType enum not found — parser is stale").toBeTruthy()
    expect(docTypeEnum![1]).toContain(PACKET_DOC_TYPE)
  })
})

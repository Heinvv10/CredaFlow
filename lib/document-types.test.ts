import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import {
  DOC_TYPE_LABELS,
  UPLOADABLE_DOC_TYPES,
  SYSTEM_GENERATED_DOC_TYPES,
  CORE_KYC_UPLOAD_DOC_TYPES,
  mayBeMisfiledSignedAgreement,
} from "./document-types"

// Read the server allow-list as TEXT rather than importing it: lib/document-auth
// pulls next-auth and prisma, which is the very reason the two lists cannot be
// one constant. Parsing the source keeps the assertion honest without dragging
// server modules into a unit test.
function serverValidDocTypes(): string[] {
  const src = readFileSync(
    path.join(process.cwd(), "lib/document-auth.ts"),
    "utf8",
  )
  const block = /export const VALID_DOC_TYPES = \[([\s\S]*?)\] as const/.exec(src)
  if (!block) throw new Error("VALID_DOC_TYPES not found — this test is blind, fix the parser")
  const found = [...block[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1])
  if (found.length === 0) throw new Error("VALID_DOC_TYPES parsed empty — this test would pass vacuously")
  return found
}

const VALID_DOC_TYPES = serverValidDocTypes()

// The picker and the server allow-list are two lists of the same thing in two
// modules that cannot import each other (document-auth pulls prisma, so it can
// never reach a client component). Left to a comment they drift, and the drift
// is invisible: the picker offers a type, the user chooses it, the server
// answers 400 "Invalid docType". That is precisely the state this file found —
// Credit Agreement, Debit Mandate and Form 20 were all offered and all dead.
describe("uploadable document types", () => {
  it("matches the server's VALID_DOC_TYPES exactly", () => {
    expect([...UPLOADABLE_DOC_TYPES].sort()).toEqual([...VALID_DOC_TYPES].sort())
  })

  it("offers nothing the system generates", () => {
    for (const generated of SYSTEM_GENERATED_DOC_TYPES) {
      expect(UPLOADABLE_DOC_TYPES).not.toContain(generated)
      expect(VALID_DOC_TYPES).not.toContain(generated)
    }
  })

  // Generated documents must still render a label wherever they are LISTED —
  // a client's document table shows their credit agreement. Dropping them from
  // DOC_TYPE_LABELS to "fix" the picker would print raw enum names instead.
  it("still labels the generated types for display", () => {
    for (const generated of SYSTEM_GENERATED_DOC_TYPES) {
      expect(DOC_TYPE_LABELS[generated]).toBeTruthy()
    }
  })

  it("labels every uploadable type", () => {
    for (const type of UPLOADABLE_DOC_TYPES) {
      expect(DOC_TYPE_LABELS[type]).toBeTruthy()
    }
  })
})

// The pre-upload warning in the upload dialog and the post-upload warning in
// app/api/documents/route.ts must cover the SAME types. They did not: the
// dialog warned only on "Other" while the route warned on everything outside
// the core KYC set, so a signed packet filed as "PO Document" got no warning
// until it was already stored — the exact gap the dialog banner exists to
// close. The route now imports this constant, so the two cannot diverge; this
// asserts the predicate built on it still says what it means.
describe("mayBeMisfiledSignedAgreement", () => {
  it("says no for every core KYC type", () => {
    for (const docType of CORE_KYC_UPLOAD_DOC_TYPES) {
      expect(mayBeMisfiledSignedAgreement(docType)).toBe(false)
    }
  })

  it("says yes for every OTHER uploadable type, not just OTHER itself", () => {
    const warned = UPLOADABLE_DOC_TYPES.filter(mayBeMisfiledSignedAgreement)
    expect([...warned].sort()).toEqual(["OTHER", "PO_DOCUMENT", "PROOF_OF_PAYMENT"])
  })

  it("says no for the empty selection", () => {
    // The dialog opens with no type chosen; warning then would fire on open.
    expect(mayBeMisfiledSignedAgreement("")).toBe(false)
  })
})

// The route builds its own Set from this constant. If someone re-inlines the
// list there, this test cannot see it — so it reads the route as text, the
// same trick serverValidDocTypes() uses and for the same reason.
describe("the upload route's core KYC set", () => {
  it("is built from CORE_KYC_UPLOAD_DOC_TYPES, not a second copy", () => {
    const src = readFileSync(
      path.join(process.cwd(), "app/api/documents/route.ts"),
      "utf8",
    )
    expect(src).toContain("new Set<DocType>(\n  CORE_KYC_UPLOAD_DOC_TYPES,\n)")
  })
})

import { describe, expect, it } from "vitest"
import type { BusinessEntityType, EntityRole } from "@prisma/client"
import {
  deriveRequiredSigners,
  isSignerSatisfied,
  outstandingSigners,
  requiredAuthorityClientIds,
  signerState,
  type SignerEvidence,
} from "./signing"

const rel = (clientId: string, role: EntityRole, active = true) => ({ clientId, role, active })
const signers = (type: BusinessEntityType, rows: ReturnType<typeof rel>[]) =>
  deriveRequiredSigners(type, rows).map((s) => `${s.document}:${s.clientId}:${s.role}`)

describe("deriveRequiredSigners", () => {
  const table: { name: string; type: BusinessEntityType; rows: ReturnType<typeof rel>[]; expected: string[] }[] = [
    {
      name: "company with authorised signatories: they sign, directors do not",
      type: "COMPANY",
      rows: [rel("d1", "DIRECTOR"), rel("a1", "AUTHORISED_SIGNATORY"), rel("a2", "AUTHORISED_SIGNATORY")],
      expected: [
        "AGREEMENT:a1:AUTHORISED_SIGNATORY", "AGREEMENT:a2:AUTHORISED_SIGNATORY",
        "RESOLUTION:a1:AUTHORISED_SIGNATORY", "RESOLUTION:a2:AUTHORISED_SIGNATORY",
      ],
    },
    {
      name: "company without signatories: every active director",
      type: "COMPANY",
      rows: [rel("d1", "DIRECTOR"), rel("d2", "DIRECTOR"), rel("d3", "DIRECTOR", false), rel("m1", "MEMBER")],
      expected: [
        "AGREEMENT:d1:AUTHORISED_SIGNATORY", "AGREEMENT:d2:AUTHORISED_SIGNATORY",
        "RESOLUTION:d1:AUTHORISED_SIGNATORY", "RESOLUTION:d2:AUTHORISED_SIGNATORY",
      ],
    },
    {
      name: "an inactive signatory does not displace the directors",
      type: "COMPANY",
      rows: [rel("a1", "AUTHORISED_SIGNATORY", false), rel("d1", "DIRECTOR")],
      expected: ["AGREEMENT:d1:AUTHORISED_SIGNATORY", "RESOLUTION:d1:AUTHORISED_SIGNATORY"],
    },
    {
      name: "trust without signatories: every active trustee; directors are irrelevant",
      type: "TRUST",
      rows: [rel("t1", "TRUSTEE"), rel("t2", "TRUSTEE"), rel("x1", "DIRECTOR")],
      expected: [
        "AGREEMENT:t1:AUTHORISED_SIGNATORY", "AGREEMENT:t2:AUTHORISED_SIGNATORY",
        "RESOLUTION:t1:AUTHORISED_SIGNATORY", "RESOLUTION:t2:AUTHORISED_SIGNATORY",
      ],
    },
    {
      name: "trust with a signatory: the signatory only",
      type: "TRUST",
      rows: [rel("t1", "TRUSTEE"), rel("a1", "AUTHORISED_SIGNATORY")],
      expected: ["AGREEMENT:a1:AUTHORISED_SIGNATORY", "RESOLUTION:a1:AUTHORISED_SIGNATORY"],
    },
    {
      name: "sureties each sign their own suretyship; an inactive surety does not",
      type: "COMPANY",
      rows: [rel("d1", "DIRECTOR"), rel("s1", "SURETY"), rel("s2", "SURETY"), rel("s3", "SURETY", false)],
      expected: [
        "AGREEMENT:d1:AUTHORISED_SIGNATORY", "RESOLUTION:d1:AUTHORISED_SIGNATORY",
        "SURETYSHIP:s1:SURETY", "SURETYSHIP:s2:SURETY",
      ],
    },
    {
      name: "a director who is also a surety signs the agreement, the resolution and their suretyship",
      type: "COMPANY",
      rows: [rel("d1", "DIRECTOR"), rel("d1", "SURETY"), rel("d1", "BENEFICIAL_OWNER")],
      expected: ["AGREEMENT:d1:AUTHORISED_SIGNATORY", "RESOLUTION:d1:AUTHORISED_SIGNATORY", "SURETYSHIP:d1:SURETY"],
    },
    {
      name: "a CC without signatories has nobody to sign for it (members are not a default)",
      type: "CC",
      rows: [rel("m1", "MEMBER"), rel("s1", "SURETY")],
      expected: ["SURETYSHIP:s1:SURETY"],
    },
    {
      name: "a partnership with a signatory: the signatory",
      type: "PARTNERSHIP",
      rows: [rel("m1", "MEMBER"), rel("a1", "AUTHORISED_SIGNATORY")],
      expected: ["AGREEMENT:a1:AUTHORISED_SIGNATORY", "RESOLUTION:a1:AUTHORISED_SIGNATORY"],
    },
    {
      name: "a surety alone is no authority",
      type: "COMPANY",
      rows: [rel("s1", "SURETY")],
      expected: ["SURETYSHIP:s1:SURETY"],
    },
  ]
  for (const row of table) {
    it(row.name, () => expect(signers(row.type, row.rows)).toEqual(row.expected))
  }

  it("lists a person with two authorising rows once", () => {
    expect(requiredAuthorityClientIds("COMPANY", [rel("a1", "AUTHORISED_SIGNATORY"), rel("a1", "AUTHORISED_SIGNATORY")])).toEqual(["a1"])
  })
})

const none: SignerEvidence = { method: null, signedAt: null, signatureSha256: null, scanDocumentId: null, confirmedById: null, confirmedAt: null }
const at = new Date("2026-10-13T10:00:00Z")

describe("signer state", () => {
  it("is satisfied only when e-signed or a wet-ink scan is confirmed", () => {
    expect(signerState(none)).toBe("PENDING")
    expect(signerState({ ...none, method: "E_SIGN", signedAt: at, signatureSha256: "a".repeat(64) })).toBe("SIGNED")
    expect(signerState({ ...none, method: "E_SIGN", signedAt: at })).toBe("PENDING")
    expect(signerState({ ...none, method: "WET_INK", scanDocumentId: "doc" })).toBe("AWAITING_CONFIRMATION")
    expect(signerState({ ...none, method: "WET_INK", scanDocumentId: "doc", confirmedById: "u2", confirmedAt: at })).toBe("CONFIRMED")
    expect(isSignerSatisfied({ ...none, method: "WET_INK", scanDocumentId: "doc" })).toBe(false)
  })

  it("lists missing rows, unsigned rows and unconfirmed scans as outstanding", () => {
    const required = deriveRequiredSigners("COMPANY", [rel("d1", "DIRECTOR"), rel("s1", "SURETY"), rel("s2", "SURETY")])
    const rows = [
      { ...none, clientId: "d1", document: "AGREEMENT" as const, method: "E_SIGN" as const, signedAt: at, signatureSha256: "a".repeat(64) },
      { ...none, clientId: "d1", document: "RESOLUTION" as const, method: "WET_INK" as const, scanDocumentId: "doc" },
      { ...none, clientId: "s1", document: "SURETYSHIP" as const },
    ]
    expect(outstandingSigners(required, rows)).toEqual([
      { clientId: "s2", document: "SURETYSHIP", state: "MISSING" },
      { clientId: "d1", document: "RESOLUTION", state: "AWAITING_CONFIRMATION" },
      { clientId: "s1", document: "SURETYSHIP", state: "PENDING" },
    ])
  })
})

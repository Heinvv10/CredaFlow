import { describe, it, expect } from "vitest"
import { Prisma } from "@prisma/client"
import { uniqueConflictField, conflictMessage } from "./duplicate"

/**
 * These tests cover the MAPPING from a unique-constraint violation to a useful
 * 409 — not the constraint itself. A mocked Prisma cannot execute a unique
 * index, so nothing here proves Postgres rejects a duplicate. That is proved by
 * the index existing (Client_idNumber_key), which is checked in the integration
 * suite, not by these assertions.
 *
 * What these DO prove is that the failure stops being an anonymous 500.
 */

const p2002 = (target: string[] | string | undefined) =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: target === undefined ? {} : { target },
  })

describe("uniqueConflictField", () => {
  it("names idNumber when the ID number collides", () => {
    expect(uniqueConflictField(p2002(["idNumber"]))).toBe("idNumber")
  })

  it("names email when the email collides", () => {
    // Email is globally unique too, and today a duplicate email 500s exactly
    // like a duplicate ID did. Same defect, same mapping.
    expect(uniqueConflictField(p2002(["email"]))).toBe("email")
  })

  it("reads a target given as a bare string rather than an array", () => {
    // Prisma has shipped both shapes depending on the connector.
    expect(uniqueConflictField(p2002("idNumber"))).toBe("idNumber")
  })

  it("picks the first field of a composite unique constraint", () => {
    expect(uniqueConflictField(p2002(["tenantId", "idNumber"]))).toBe("tenantId")
  })

  it("returns null for a P2002 that names no target", () => {
    expect(uniqueConflictField(p2002(undefined))).toBeNull()
  })

  it("returns null for a different Prisma error", () => {
    const notFound = new Prisma.PrismaClientKnownRequestError("Not found", {
      code: "P2025",
      clientVersion: "test",
    })
    expect(uniqueConflictField(notFound)).toBeNull()
  })

  it("returns null for an ordinary error, so unrelated failures still surface as 500", () => {
    // A mapping that swallowed every error into a 409 would hide real faults.
    expect(uniqueConflictField(new Error("database is on fire"))).toBeNull()
  })

  it("returns null for a thrown non-error value", () => {
    expect(uniqueConflictField("nope")).toBeNull()
  })
})

describe("conflictMessage", () => {
  it("describes an ID-number clash in the words staff use", () => {
    expect(conflictMessage("idNumber")).toBe("A client with this ID number already exists")
  })

  it("describes an email clash", () => {
    expect(conflictMessage("email")).toBe("A client with this email address already exists")
  })

  it("falls back to a generic sentence for any other unique field", () => {
    // Never leak a raw column name at a staff member.
    expect(conflictMessage("someNewColumn")).toBe("A client with these details already exists")
  })
})

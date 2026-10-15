import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import type { ScreeningSubject, SubjectRef } from "./types"

type RawDb = Pick<typeof prisma, "$queryRaw">

export function subjectWhere(ref: SubjectRef): { clientId: string } | { entityId: string } {
  return "clientId" in ref ? { clientId: ref.clientId } : { entityId: ref.entityId }
}

export function subjectKey(ref: SubjectRef): string {
  return "clientId" in ref ? `client:${ref.clientId}` : `entity:${ref.entityId}`
}

/** The ref of a stored check or block, whose CHECK guarantees exactly one id. */
export function refOf(row: { clientId: string | null; entityId: string | null }): SubjectRef {
  return row.clientId ? { clientId: row.clientId } : { entityId: row.entityId as string }
}

const cidOf = (ref: SubjectRef) => ("clientId" in ref ? ref.clientId : null)
const eidOf = (ref: SubjectRef) => ("entityId" in ref ? ref.entityId : null)

/**
 * The subject's identity as of now, from the database function that the
 * approval trigger also uses (screeningCurrentFingerprint), so the two can
 * never disagree about whether a run screened this identity.
 */
export async function currentFingerprint(db: RawDb, tenantId: string, ref: SubjectRef): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ fp: string | null }>>(
    Prisma.sql`SELECT "screeningCurrentFingerprint"(${tenantId}, ${cidOf(ref)}, ${eidOf(ref)}) AS fp`,
  )
  return rows[0]?.fp ?? null
}

/** The subject as a provider sees it, with its fingerprint; null when it is not this tenant's. */
export async function loadSubject(
  db: RawDb,
  tenantId: string,
  ref: SubjectRef,
): Promise<{ subject: ScreeningSubject; fingerprint: string } | null> {
  if ("clientId" in ref) {
    const rows = await db.$queryRaw<Array<{ id: string; firstName: string; lastName: string; idNumber: string; dateOfBirth: Date | null; fp: string }>>(
      Prisma.sql`SELECT c.id, c."firstName", c."lastName", c."idNumber", c."dateOfBirth",
        "screeningCurrentFingerprint"(c."tenantId", c.id, NULL) AS fp
        FROM "Client" c WHERE c.id = ${ref.clientId} AND c."tenantId" = ${tenantId}`,
    )
    const c = rows[0]
    if (!c) return null
    return {
      subject: {
        kind: "PERSON", clientId: c.id, firstName: c.firstName, lastName: c.lastName, idNumber: c.idNumber,
        dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : null,
      },
      fingerprint: c.fp,
    }
  }
  const rows = await db.$queryRaw<Array<{ id: string; type: string; legalName: string; registrationNumber: string; fp: string }>>(
    Prisma.sql`SELECT e.id, e.type::text AS type, e."legalName", e."registrationNumber",
      "screeningCurrentFingerprint"(e."tenantId", NULL, e.id) AS fp
      FROM "BusinessEntity" e WHERE e.id = ${ref.entityId} AND e."tenantId" = ${tenantId}`,
  )
  const e = rows[0]
  if (!e) return null
  return {
    subject: { kind: "ENTITY", entityId: e.id, entityType: e.type, legalName: e.legalName, registrationNumber: e.registrationNumber },
    fingerprint: e.fp,
  }
}

/**
 * Everyone screened for an application: the client, or the entity and every
 * person actively related to it (directors, members, trustees, signatories,
 * sureties, beneficial owners) — the set the approval trigger checks.
 */
export async function borrowerSubjects(
  db: Pick<typeof prisma, "entityRelationship">,
  tenantId: string,
  borrower: { clientId: string | null; entityId: string | null },
): Promise<SubjectRef[]> {
  if (borrower.clientId) return [{ clientId: borrower.clientId }]
  if (!borrower.entityId) return []
  const related = await db.entityRelationship.findMany({
    where: { tenantId, entityId: borrower.entityId, active: true },
    select: { clientId: true },
    distinct: ["clientId"],
    orderBy: { clientId: "asc" },
  })
  return [{ entityId: borrower.entityId }, ...related.map((r) => ({ clientId: r.clientId }))]
}

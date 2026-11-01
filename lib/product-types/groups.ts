import type { prisma } from "@/lib/prisma"

/** The ID numbers of a group's members: at least two different ones, or null. */
export function memberIdNumbers(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || v.trim().length === 0)) return null
  const ids = [...new Set(raw.map((v: string) => v.trim()))]
  return ids.length >= 2 && ids.length <= 100 ? ids : null
}

/** The lender's clients with these ID numbers, or the ID numbers it has no client for. */
export async function resolveMembers(db: Pick<typeof prisma, "client">, tenantId: string, idNumbers: string[]): Promise<{ clientIds: string[] } | { missing: string[] }> {
  const rows = await db.client.findMany({ where: { tenantId, idNumber: { in: idNumbers } }, select: { id: true, idNumber: true } })
  const found = new Set(rows.map((r) => r.idNumber))
  const missing = idNumbers.filter((id) => !found.has(id))
  return missing.length > 0 ? { missing } : { clientIds: rows.map((r) => r.id) }
}

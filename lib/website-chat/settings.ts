import { prisma } from "@/lib/prisma"

/**
 * Read-only: getCommsSettings upserts, and the chat routes are hit by anonymous
 * visitors. A missing row means the schema default (botsEnabled = true).
 */
export async function chatBotsEnabled(tenantId: string): Promise<boolean> {
  const row = await prisma.commsSettings.findUnique({ where: { tenantId }, select: { botsEnabled: true } })
  return row?.botsEnabled ?? true
}

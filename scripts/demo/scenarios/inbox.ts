/**
 * The borrower's email inbox, for the one message a scenario must read: the
 * portal activation code that POST /api/portal/register emails.
 *
 * The sim tenant has no email provider (and must never mail a fictional
 * address), so the code exists only in the ClientOtp row the route writes
 * before it answers. Reading it is the simulator standing in for the consumer
 * opening the email. READ-ONLY: this is the only database access in the
 * scenarios, and it never writes.
 */
import { PrismaClient } from "@prisma/client"

import { simEnv } from "../sim/env"

let prisma: PrismaClient | null = null

function db(): PrismaClient {
  prisma ??= new PrismaClient({ datasourceUrl: simEnv("SIM_HOST_DATABASE_URL") })
  return prisma
}

/** The newest unused activation code sent to `email` at or after `since`. */
export async function readActivationCode(email: string, since: Date): Promise<string> {
  const row = await db().clientOtp.findFirst({
    where: { email, used: false, createdAt: { gte: new Date(since.getTime() - 1000) } },
    orderBy: { createdAt: "desc" },
    select: { otp: true },
  })
  if (!row) throw new Error(`no portal activation code was issued to ${email} since ${since.toISOString()}`)
  return row.otp
}

export async function closeInbox(): Promise<void> {
  await prisma?.$disconnect()
  prisma = null
}

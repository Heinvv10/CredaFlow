/**
 * READ-ONLY database access for the simulator: what a member of staff reads off
 * a screen the API does not serve as JSON (a loan's repayment schedule, the
 * day's bank-reconciliation proposals), the post-run checks, and nothing else.
 *
 * Enforced by Postgres, not by convention: every session opens with
 * `default_transaction_read_only=on`, so a write through this client fails
 * with SQLSTATE 25006 instead of quietly changing the simulated history.
 */
import { PrismaClient } from "@prisma/client"

import { simEnv } from "./env"

let client: PrismaClient | null = null

export function readDb(): PrismaClient {
  if (!client) {
    const url = new URL(simEnv("SIM_HOST_DATABASE_URL"))
    url.searchParams.set("options", "-c default_transaction_read_only=on")
    client = new PrismaClient({ datasourceUrl: url.toString() })
  }
  return client
}

export async function closeReadDb(): Promise<void> {
  await client?.$disconnect()
  client = null
}

/**
 * A throwaway, migrated database next to DATABASE_URL's, for the integration
 * suites whose rule is about the whole instance (one jurisdiction per database)
 * and so cannot share the integration database, which holds hundreds of ZA
 * lenders. The role in DATABASE_URL needs CREATEDB.
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"

export interface ThrowawayDb {
  name: string
  url: string
  db: PrismaClient
  /** Drops it. */
  drop: () => Promise<void>
}

export async function createThrowawayDb(opts: { instance?: { jurisdiction: "ZA" | "LS"; currency: "ZAR" | "LSL" } } = {}): Promise<ThrowawayDb> {
  const admin = new PrismaClient()
  const name = `jur_it_${randomBytes(6).toString("hex")}`
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.pathname = `/${name}`
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ["ignore", "pipe", "pipe"],
  })
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  // The migration leaves ZA / ZAR on an empty database; a Lesotho suite sets its own, as an operator does.
  if (opts.instance && (opts.instance.jurisdiction !== "ZA" || opts.instance.currency !== "ZAR")) {
    await db.instanceJurisdiction.update({ where: { id: 1 }, data: opts.instance })
  }
  return {
    name, url: url.toString(), db,
    drop: async () => {
      await db.$disconnect()
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.$disconnect()
    },
  }
}

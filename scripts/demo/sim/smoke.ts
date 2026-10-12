/**
 * Smoke test for the demo-sim stack (T1). Brings nothing up: it expects
 * docker-compose.demo-sim.yml running, migrated and base-seeded, with the
 * seed's credentials captured in scripts/demo/.sim-credentials.txt.
 *
 *   npx tsx scripts/demo/sim/smoke.ts
 *
 * Prints what it observed; never prints a credential.
 */
import { SimClient } from "./api"
import { advanceDays, appNow, now, setClock } from "./clock"
import { readSeedCredentials } from "./credentials"
import { log } from "./env"

const START = new Date("2026-04-01T09:00:00+02:00")
// prisma/seed.ts CLIENTS[3]; owns the seeded loan LN-SEED-0001.
const PORTAL_CLIENT_EMAIL = "thandi.mthembu@acme-lending.invalid"

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

async function main(): Promise<void> {
  const creds = readSeedCredentials()
  const rewound = now().getTime() > START.getTime()

  const start = await setClock(START)
  out(`clock set      : app reports ${start.toISOString()}`)

  const staff = new SimClient()
  try {
    await staff.loginStaff(creds.admin.email, creds.admin.password, creds.admin.totpSecret)
  } catch (err) {
    if (rewound) {
      log("the clock was moved BACK to the start date; TOTP replay protection (User.lastTotpCounter) " +
        "rejects a code older than the last one used, so reset the sim DB before re-running the smoke")
    }
    throw err
  }
  out(`staff login    : ${staff.user?.email} role=${staff.user?.role} totpVerified=${staff.user?.totpVerified} at ${(await appNow()).toISOString()}`)
  const products = await staff.get<Array<{ code: string }>>("/api/products/loan")
  out(`staff GET      : /api/products/loan → ${products.status}, ${products.json?.length ?? 0} products (${products.json?.map((p) => p.code).join(", ")})`)

  const client = new SimClient()
  await client.loginClient(PORTAL_CLIENT_EMAIL, creds.portalPassword)
  out(`client login   : ${client.user?.email} role=${client.user?.role} at ${(await appNow()).toISOString()}`)
  const docs = await client.get<unknown>(`/api/clients/${client.user?.id}/documents`)
  out(`client GET     : /api/clients/<own id>/documents → ${docs.status}`)
  const foreign = await client.get<unknown>("/api/products/loan", { expect: [403] })
  out(`client denied  : /api/products/loan → ${foreign.status} (staff API refused to a CLIENT session)`)

  const later = await advanceDays(30)
  out(`clock advanced : +30 days, app reports ${later.toISOString()}`)
  const staleSession = await staff.session()
  out(`staff session  : ${staleSession ? "still valid" : "expired (JWT maxAge is 30 days)"} after the jump`)
  await staff.loginStaff(creds.admin.email, creds.admin.password, creds.admin.totpSecret)
  const again = await staff.get<unknown[]>("/api/products/loan")
  out(`staff relogin  : TOTP for ${(await appNow()).toISOString()} accepted; /api/products/loan → ${again.status}`)
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

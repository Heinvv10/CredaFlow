/**
 * The base seed's credentials, as captured from `SEED_PRINT_CREDENTIALS=1
 * npx tsx prisma/seed.ts` into scripts/demo/.sim-credentials.txt (chmod 600,
 * untracked). Never logged.
 */
import { readFileSync } from "node:fs"

import { SIM_CREDENTIALS_FILE } from "./env"

export interface StaffCredentials {
  email: string
  password: string
  totpSecret: string
}

export interface SeedCredentials {
  admin: StaffCredentials
  officer: StaffCredentials
  /** The portal password the seed gives every seeded client. */
  portalPassword: string
}

function staff(text: string, role: "ADMIN" | "CREDIT_OFFICER"): StaffCredentials | null {
  const match = new RegExp(
    `^\\s*${role}: (\\S+)\\s*\\n\\s*password: (\\S+)\\s*\\n\\s*TOTP secret \\(base32\\): (\\S+)`,
    "m",
  ).exec(text)
  return match ? { email: match[1], password: match[2], totpSecret: match[3] } : null
}

export function readSeedCredentials(file = SIM_CREDENTIALS_FILE): SeedCredentials {
  const text = readFileSync(file, "utf8")
  const admin = staff(text, "ADMIN")
  const officer = staff(text, "CREDIT_OFFICER")
  const portal = /^\s*Client portal password[^:]*: (\S+)/m.exec(text)
  if (!admin || !officer || !portal) {
    throw new Error(`${file} does not hold the seed's ADMIN, CREDIT_OFFICER and portal credentials`)
  }
  return { admin, officer, portalPassword: portal[1] }
}

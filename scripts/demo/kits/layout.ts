/**
 * Where live-demo kits go. Kits hold ID cards printed with the presenter's
 * real photo, so they live outside git under a chmod-700 directory.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const KITS_ROOT = join(homedir(), 'credaflow-demo-data', 'kits')

export function defaultKitDir(asOf: string): string {
  return join(KITS_ROOT, asOf)
}

/**
 * Where the staff logins come from. A restore loads the BAKE's database, so
 * the staff accounts are the sim seed's, not the live demo stack's own seed.
 * bake.sh copies both files into the snapshot; the copies under scripts/demo/
 * are overwritten by the next simulator run, the snapshot's are not.
 */
export const CREDENTIALS_SOURCE =
  '.sim-credentials.txt in the snapshot the demo was restored from (~/credaflow-demo-data/snapshots/latest/); the LOAN_ADMIN is in .sim-staff.json beside it'

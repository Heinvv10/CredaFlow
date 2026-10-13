import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// restore.sh end to end against stubs. docker, docker-compose, curl and sleep
// are shell stubs on PATH that answer what restore.sh asks and append every
// docker call to a log; nothing reaches a real container.

const SCRIPT = join(__dirname, 'restore.sh')
const IMAGE = 'credaflow:restore-test'
const TENANT = 'cm0000000000000000000000'
const COUNTS = { loans: 1, applications: 2, clients: 3, users: 4, payments: 5, clientDocuments: 6, insurancePolicies: 7 }

let root: string
let log: string

const DOCKER_STUB = String.raw`#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$*" in
  "inspect credaflow-demo-"*) exit 0 ;;
  *"com.docker.compose.project.working_dir"*) echo "$STUB_LIVE_DIR" ;;
  *"com.docker.compose.project"*) echo credaflow-demo ;;
  *"range .Config.Env"*) echo "DEMO_MODE=$STUB_DEMO_MODE"; [ -z "$STUB_CLEAR_TOTP" ] || echo "DEMO_CLEAR_STAFF_TOTP=true" ;;
  "inspect -f {{.Config.Image}} "*) echo "$STUB_IMAGE" ;;
  *"range .Mounts"*) echo uploads-vol ;;
  *"HostPort"*) echo 3300 ;;
  *"HostIp"*) echo 127.0.0.1 ;;
  "exec credaflow-demo-db printenv POSTGRES_DB") echo demo ;;
  "exec -e DB="*)
    case "$*" in
      *"SELECT 1 FROM pg_database"*) echo 1 ;;
      *"FROM pg_database WHERE left"*) ;;
      *'UPDATE "User"'*) echo 3 ;;
      *'json_build_object'*) echo "$STUB_COUNTS" ;;
    esac ;;
  "run --rm -i"*)
    cat > /dev/null
    case "$*" in *"wc -l"*) echo 9 ;; esac ;;
esac
exit 0
`

function run(env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: root,
      DEMO_DATA_DIR: join(root, 'data'), LIVE_DIR: join(root, 'live'),
      STUB_LOG: log, STUB_LIVE_DIR: join(root, 'live'), STUB_IMAGE: IMAGE, STUB_DEMO_MODE: 'true', STUB_COUNTS: JSON.stringify(COUNTS),
      ...env,
    },
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8').split('\n') }
}

const clearCalls = (calls: string[]) => calls.filter((c) => c.includes('UPDATE "User"'))
const policyCalls = (calls: string[]) => calls.filter((c) => c.includes('UPDATE "TenantConfig" SET "requireStaffTotp" = false'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'demo-restore-'))
  log = join(root, 'docker.log')
  writeFileSync(log, '')
  mkdirSync(join(root, 'bin'))
  const stub = (name: string, body: string) => {
    writeFileSync(join(root, 'bin', name), body)
    chmodSync(join(root, 'bin', name), 0o755)
  }
  stub('docker', DOCKER_STUB)
  stub('docker-compose', '#!/bin/sh\necho "docker-compose $*" >> "$STUB_LOG"\nexit 0\n')
  stub('sleep', '#!/bin/sh\nexit 0\n')
  stub('curl', '#!/bin/sh\necho "curl $*" >> "$STUB_LOG"\n[ -z "$STUB_HEALTH_FAIL" ]\n')
  mkdirSync(join(root, 'live'))
  writeFileSync(join(root, 'live', 'docker-compose.demo.yml'), '')
  writeFileSync(join(root, 'live', '.env.production'), 'DEBIT_MANDATE_CREDITOR_TENANT_ID=old\n')
  writeFileSync(join(root, 'live', '.env'), 'NEXT_PUBLIC_TENANT_SLUG=acme\n')
  const snap = join(root, 'data', 'snapshots', 'latest')
  mkdirSync(snap, { recursive: true })
  writeFileSync(join(snap, 'meta.json'), JSON.stringify({ image: IMAGE, tenantSlug: 'acme', tenantId: TENANT, counts: { ...COUNTS, uploadFiles: 9 } }))
  writeFileSync(join(snap, 'db.dump'), 'x')
  writeFileSync(join(snap, 'uploads.tar.gz'), 'x')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('restore.sh demo staff TOTP', () => {
  it('clears TOTP once, on the restored live db, after the health checks, and logs the count', () => {
    const r = run()
    expect(r.status).toBe(0)
    const clears = clearCalls(r.calls)
    expect(clears).toHaveLength(1)
    expect(clears[0]).toContain('DB=demo ')
    expect(clears[0]).toContain('"totpEnabled" = false, "totpSecret" = NULL, "lastTotpCounter" = NULL')
    expect(r.out).toMatch(/TOTP cleared for 3 non-SUPER_ADMIN users/)
    // After the swap and the app start, before the drop of the old db.
    const idx = (needle: string) => r.calls.findIndex((c) => c.includes(needle))
    expect(idx('UPDATE "User"')).toBeGreaterThan(idx('RENAME TO "demo"'))
    expect(idx('UPDATE "User"')).toBeGreaterThan(idx('docker-compose'))
    expect(r.calls.filter((c) => c.startsWith('curl ')).length).toBe(2)
    expect(idx('UPDATE "User"')).toBeGreaterThan(r.calls.map((c) => c.startsWith('curl ')).lastIndexOf(true))
    expect(idx('UPDATE "User"')).toBeLessThan(idx('DROP DATABASE "demo_old_'))
  })

  // With the policy on (the default), staff whose TOTP was just cleared would
  // be held at the enrolment page and the demo could not be presented.
  it('switches the staff 2FA policy off on the restored live db, right after clearing TOTP', () => {
    const r = run()
    const policy = policyCalls(r.calls)
    expect(policy).toHaveLength(1)
    expect(policy[0]).toContain('DB=demo ')
    const idx = (needle: string) => r.calls.findIndex((c) => c.includes(needle))
    expect(idx('UPDATE "TenantConfig"')).toBeGreaterThan(idx('UPDATE "User"'))
    expect(idx('UPDATE "TenantConfig"')).toBeLessThan(idx('DROP DATABASE "demo_old_'))
    expect(r.out).toMatch(/staff 2FA policy switched off/)
  })

  it('with DEMO_CLEAR_STAFF_TOTP=true also clears TOTP and the policy in the staged db, before the swap', () => {
    const r = run({ STUB_CLEAR_TOTP: '1' })
    expect(r.status).toBe(0)
    const policy = policyCalls(r.calls)
    expect(policy).toHaveLength(2)
    expect(policy[0]).toMatch(/DB=demo_restore_/)
    expect(clearCalls(r.calls)).toHaveLength(2)
    const idx = (needle: string) => r.calls.findIndex((c) => c.includes(needle))
    expect(idx('UPDATE "TenantConfig"')).toBeLessThan(idx('RENAME TO "demo"'))
    expect(policy[1]).toContain('DB=demo ')
  })

  it('spares SUPER_ADMIN', () => {
    const [clear] = clearCalls(run().calls)
    expect(clear).toContain("WHERE role <> 'SUPER_ADMIN'")
  })

  it('does not clear TOTP when the restore fails before the swap', () => {
    const r = run({ STUB_COUNTS: '{}' })
    expect(r.status).not.toBe(0)
    expect(clearCalls(r.calls)).toHaveLength(0)
    expect(policyCalls(r.calls)).toHaveLength(0)
  })

  it('does not clear TOTP when the health check fails and the restore rolls back', () => {
    const r = run({ STUB_HEALTH_FAIL: '1' })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/rolling back/)
    expect(clearCalls(r.calls)).toHaveLength(0)
    expect(policyCalls(r.calls)).toHaveLength(0)
  })

  it('does not clear TOTP on a target started from another working_dir', () => {
    const r = run({ STUB_LIVE_DIR: join(root, 'elsewhere') })
    expect(r.status).not.toBe(0)
    expect(clearCalls(r.calls)).toHaveLength(0)
  })

  it('does not clear TOTP on a stack whose labels match but DEMO_MODE is not true', () => {
    const r = run({ STUB_DEMO_MODE: 'false' })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/DEMO_MODE=true/)
    expect(clearCalls(r.calls)).toHaveLength(0)
  })
})

describe('restore.sh lender guard', () => {
  const meta = join('data', 'snapshots', 'latest', 'meta.json')
  const setSlug = (slug: string | undefined) => {
    const m = JSON.parse(readFileSync(join(root, meta), 'utf8'))
    writeFileSync(join(root, meta), JSON.stringify({ ...m, tenantSlug: slug }))
  }

  it.each([['another lender', 'fairscore'], ['no slug', undefined]])('refuses a snapshot with %s before touching the stack', (_what, slug) => {
    setSlug(slug)
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/the live stack serves 'acme'/)
    expect(r.calls.some((c) => c.includes('RENAME') || c.startsWith('docker-compose'))).toBe(false)
  })

  it('refuses a live dir whose .env names no tenant slug', () => {
    writeFileSync(join(root, 'live', '.env'), '')
    const r = run()
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/no NEXT_PUBLIC_TENANT_SLUG/)
  })
})

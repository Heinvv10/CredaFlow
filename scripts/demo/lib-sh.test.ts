import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_LENDERS } from '@/prisma/demo-lender'

// Pure helpers of scripts/demo/lib.sh, called from a shell that sources it.

const LIB = join(__dirname, 'lib.sh')

function call(fn: string, ...args: string[]): string {
  const r = spawnSync('bash', ['-c', `. "$0"; ${fn} "$@"`, LIB, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${fn}: ${r.stderr}`)
  return r.stdout.trim()
}

describe('host_addr', () => {
  it.each([
    ['', '127.0.0.1:3300'],
    ['0.0.0.0', '127.0.0.1:3300'],
    ['::', '127.0.0.1:3300'],
    ['[::]', '127.0.0.1:3300'],
    ['127.0.0.1', '127.0.0.1:3300'],
    ['::1', '[::1]:3300'],
    ['fd00::5', '[fd00::5]:3300'],
    ['[::1]', '[::1]:3300'],
  ])('bind address %j is reached at %s', (ip, addr) => {
    expect(call('host_addr', ip, '3300')).toBe(addr)
  })
})

describe('seed_passwords_ok', () => {
  const ok = (content: string) => {
    const file = join(mkdtempSync(join(tmpdir(), 'seed-pw-')), 'seed-passwords.env')
    writeFileSync(file, content)
    return spawnSync('bash', ['-c', '. "$0"; seed_passwords_ok "$1"', LIB, file]).status === 0
  }

  it('accepts SEED_*_PASSWORD lines and blank lines', () => {
    expect(ok('SEED_ADMIN_PASSWORD=Demo-x!\n\nSEED_AF_SURETY_PASSWORD=y\n')).toBe(true)
  })

  it.each([
    ['DATABASE_URL=postgresql://x@h/db\n'],
    ['SEED_ADMIN_PASSWORD=a\nLD_PRELOAD=/evil.so\n'],
    ['FAKETIME_TIMESTAMP_FILE=/x\n'],
    ['SEED_ADMIN_PASSWORD=\n'],
    ['export SEED_ADMIN_PASSWORD=a\n'],
    ['# note\nSEED_ADMIN_PASSWORD=a\n'],
    ['SEED_PRINT_CREDENTIALS=0\n'],
  ])('refuses %j', (content) => {
    expect(ok(content)).toBe(false)
  })
})

// #147 follow-up: the marker names exactly the seeded demo lenders' slugs, so a
// lender added to prisma/demo-lender.ts without lib.sh fails here.
describe('TENANT_DEMO_LENDER_SQL', () => {
  it('marks only the tenants whose slug is a seeded demo lender', () => {
    const r = spawnSync('bash', ['-c', '. "$0"; printf %s "$TENANT_DEMO_LENDER_SQL"', LIB], { encoding: 'utf8' })
    const sql = r.stdout
    expect(sql).toContain('SET "isDemoLender" = true')
    const list = /WHERE "tenantId" IN \(SELECT id FROM "Tenant" WHERE slug IN \(([^)]*)\)\)/.exec(sql)
    expect(list).not.toBeNull()
    const slugs = list![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(slugs.sort()).toEqual(Object.values(DEMO_LENDERS).map((l) => l.slug).sort())
  })
})

describe('sim_env_preflight', () => {
  // docker is a stub that prints the container env it is told to.
  const preflight = (containerEnv: string[], withSecret = true) => {
    const dir = mkdtempSync(join(tmpdir(), 'sim-preflight-'))
    writeFileSync(join(dir, 'docker'), `#!/bin/sh\nprintf '%s\\n' ${containerEnv.map((e) => `'${e}'`).join(' ')}\n`, { mode: 0o755 })
    const secrets = join(dir, 'secrets.env')
    writeFileSync(secrets, withSecret ? 'UNSUB_TOKEN_SECRET=synthetic-secret\n' : '')
    const r = spawnSync('bash', ['-c', '. "$0"; SHARED_SECRETS="$1"; SIM_APP=sim-app; sim_env_preflight', LIB, secrets], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const full = ['DEMO_MODE=true', 'AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1', 'UNSUB_TOKEN_SECRET=synthetic-secret']

  it('passes a sim app that carries DEMO_MODE, the audit allowance and the signing secret', () => {
    expect(preflight(full).status).toBe(0)
  })

  it('names the audit allowance when the sim app lacks it: DEMO_MODE alone does not allow a privileged database role', () => {
    const r = preflight(['DEMO_MODE=true', 'UNSUB_TOKEN_SECRET=synthetic-secret'])
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('AUDIT_ALLOW_PRIVILEGED_DB_ROLE=1')
    expect(preflight(['DEMO_MODE=true', 'AUDIT_ALLOW_PRIVILEGED_DB_ROLE=0', 'UNSUB_TOKEN_SECRET=synthetic-secret']).status).not.toBe(0)
  })
})

describe('ensure_demo_audit_env', () => {
  const setup = (envText: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-env-'))
    const file = join(dir, '.env.production')
    writeFileSync(file, envText, { mode: 0o600 })
    return { dir, file, backups: join(dir, 'backups') }
  }
  const run = (file: string, backups: string) =>
    spawnSync('bash', ['-c', '. "$0"; ensure_demo_audit_env "$1" "$2"', LIB, file, backups], { encoding: 'utf8' })
  const read = (file: string) => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const backupsOf = (backups: string) => (existsSync(backups) ? readdirSync(backups) : [])
  const KEY = 'k'.repeat(48)

  it('adds the allowance and a generated 48-byte key to a DEMO_MODE=true env, backs the file up first, and names the keys but never a value', () => {
    const { file, backups } = setup('DEMO_MODE=true\nTENANT_HOST_MAP=a.example=acme\n')
    const r = run(file, backups)
    expect(r.status, r.stderr).toBe(0)
    const env = read(file)
    expect(env.AUDIT_ALLOW_PRIVILEGED_DB_ROLE).toBe('1')
    expect(env.AUDIT_CHAIN_KEY).toMatch(/^[A-Za-z0-9+/]{64}$/) // 48 bytes of base64
    expect(env.TENANT_HOST_MAP).toBe('a.example=acme')
    const [backup] = backupsOf(backups)
    expect(backup).toMatch(/^\.env\.production\.pre-audit-\d{8}T\d{6}Z$/)
    expect(readFileSync(join(backups, backup), 'utf8')).toBe('DEMO_MODE=true\nTENANT_HOST_MAP=a.example=acme\n')
    expect(statSync(join(backups, backup)).mode & 0o777).toBe(0o600)
    expect(r.stderr).toContain('AUDIT_ALLOW_PRIVILEGED_DB_ROLE')
    expect(r.stderr).toContain('AUDIT_CHAIN_KEY')
    expect(r.stderr).not.toContain(env.AUDIT_CHAIN_KEY)
  })

  it('is idempotent: a second run changes and backs up nothing, and the key stays the same', () => {
    const { file, backups } = setup('DEMO_MODE=true\n')
    run(file, backups)
    const after = readFileSync(file, 'utf8')
    const r = run(file, backups)
    expect(r.status).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(after)
    expect(backupsOf(backups)).toHaveLength(1)
    expect(r.stderr).toContain('already has')
  })

  it('never replaces an existing key (rotating it would orphan the history), and only adds what is missing', () => {
    const { file, backups } = setup(`DEMO_MODE=true\nAUDIT_CHAIN_KEY=${KEY}\n`)
    run(file, backups)
    expect(read(file)).toMatchObject({ AUDIT_CHAIN_KEY: KEY, AUDIT_ALLOW_PRIVILEGED_DB_ROLE: '1' })
    const { file: file2, backups: backups2 } = setup('DEMO_MODE=true\nAUDIT_ALLOW_PRIVILEGED_DB_ROLE=1\n')
    run(file2, backups2)
    expect(read(file2).AUDIT_CHAIN_KEY).toMatch(/^[A-Za-z0-9+/]{64}$/)
  })

  it('reports a key that is too short and leaves it', () => {
    const { file, backups } = setup('DEMO_MODE=true\nAUDIT_CHAIN_KEY=short\nAUDIT_ALLOW_PRIVILEGED_DB_ROLE=1\n')
    const r = run(file, backups)
    expect(r.stderr).toMatch(/WARNING: AUDIT_CHAIN_KEY .* shorter than 32/)
    expect(read(file).AUDIT_CHAIN_KEY).toBe('short')
    expect(backupsOf(backups)).toEqual([])
  })

  it('leaves an env that does not say DEMO_MODE=true completely alone: no flag, no key, no backup', () => {
    for (const text of ['NODE_ENV=production\n', 'DEMO_MODE=false\n', 'DEMO_MODE=1\n']) {
      const { file, backups } = setup(text)
      const r = run(file, backups)
      expect(r.status).toBe(0)
      expect(readFileSync(file, 'utf8')).toBe(text)
      expect(backupsOf(backups)).toEqual([])
      expect(r.stderr).toContain('left alone')
    }
  })

  it('turns an allowance that is set to something other than 1 into 1', () => {
    const { file, backups } = setup(`DEMO_MODE=true\nAUDIT_ALLOW_PRIVILEGED_DB_ROLE=0\nAUDIT_CHAIN_KEY=${KEY}\n`)
    run(file, backups)
    expect(read(file).AUDIT_ALLOW_PRIVILEGED_DB_ROLE).toBe('1')
  })
})

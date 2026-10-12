import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { describe, expect, it } from 'vitest'
import { STAFF } from '../breadth/staff'
import { OPERATOR_TENANT_SLUG, SIM_DATABASE_MARKER, parseOperatorCredentials, provisionOperator, targetRefusal, type OperatorDb } from './operator'
import { SIM_DB_SERVICE_ADDRESS } from './env'

// provisionOperator against an in-memory stand-in for the four Prisma calls it
// makes. It cannot see a database constraint; the bake is what runs it against
// the sim's Postgres.

interface UserRow { id: string; email: string; name: string; role: string; tenantId: string | null; password: string; totpSecret: string | null; totpEnabled: boolean; active: boolean }

function fakeDb(opts: { marker?: string | null; users?: UserRow[] } = {}) {
  const users: UserRow[] = opts.users ?? []
  const tenants = [{ id: 't-acme', slug: OPERATOR_TENANT_SLUG }, { id: 't-other', slug: 'other' }]
  let writes = 0
  const db = {
    $queryRaw: async () => [{ marker: opts.marker === undefined ? SIM_DATABASE_MARKER : opts.marker }],
    tenant: {
      findUnique: async ({ where }: { where: { slug: string } }) => tenants.find((t) => t.slug === where.slug) ?? null,
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => users.find((u) => u.email === where.email) ?? null,
      count: async ({ where }: { where: { tenantId: string; role: string; email: { not: string } } }) =>
        users.filter((u) => u.tenantId === where.tenantId && u.role === where.role && u.email !== where.email.not).length,
      upsert: async ({ where, update, create }: { where: { email: string }; update: Partial<UserRow>; create: Omit<UserRow, 'id'> }) => {
        writes++
        const found = users.find((u) => u.email === where.email)
        if (found) {
          Object.assign(found, update)
          return { id: found.id }
        }
        const row = { ...create, id: `u-${users.length + 1}` }
        users.push(row)
        return { id: row.id }
      },
    },
  }
  return { db: db as unknown as OperatorDb, users, writes: () => writes }
}

const user = (over: Partial<UserRow>): UserRow => ({
  id: 'u-x', email: 'someone@example.invalid', name: 'X', role: 'ADMIN', tenantId: 't-acme', password: 'hash', totpSecret: 'SECRET', totpEnabled: true, active: true, ...over,
})

describe('targetRefusal', () => {
  it.each([
    'postgresql://u:p@db:5432/credaflow',
    'postgres://u:p@db/credaflow',
  ])('accepts the sim db service: %s', (url) => {
    expect(targetRefusal({ DATABASE_URL: url, NODE_ENV: 'development' })).toBeNull()
  })

  it.each([
    'postgresql://u:p@127.0.0.1:5456/credaflow',
    'postgresql://u:p@credaflow-demo-db:5432/credaflow',
    'postgresql://u:p@db:5433/credaflow',
    'postgresql://u:p@db.example.com:5432/credaflow',
    'not a url',
    '',
  ])('refuses any other target: %j', (url) => {
    expect(targetRefusal({ DATABASE_URL: url, NODE_ENV: 'development' })).toMatch(/refused/)
  })

  it('refuses NODE_ENV=production even on the sim db', () => {
    expect(targetRefusal({ DATABASE_URL: 'postgresql://u:p@db:5432/x', NODE_ENV: 'production' })).toMatch(/NODE_ENV=production/)
  })

  it('names the address the sim compose service has', () => {
    expect(SIM_DB_SERVICE_ADDRESS).toBe('db:5432')
  })

  it('uses the marker fresh-stack.sh writes (SIM_DB_MARKER in lib.sh)', () => {
    const r = spawnSync('bash', ['-c', '. "$0"; printf %s "$SIM_DB_MARKER"', join(__dirname, '..', 'lib.sh')], { encoding: 'utf8' })
    expect(r.stdout).toBe(SIM_DATABASE_MARKER)
  })
})

describe('provisionOperator', () => {
  it('creates one TOTP-enrolled SUPER_ADMIN in the acme tenant whose password is the one returned', async () => {
    const f = fakeDb()
    const creds = await provisionOperator(f.db)
    expect(f.users).toHaveLength(1)
    const row = f.users[0]!
    expect(row).toMatchObject({ email: STAFF.operator.email, role: 'SUPER_ADMIN', tenantId: 't-acme', totpEnabled: true, active: true, totpSecret: creds.totpSecret })
    expect(creds).toMatchObject({ userId: row.id, email: STAFF.operator.email })
    expect(await bcrypt.compare(creds.password, row.password)).toBe(true)
  })

  it('keeps the TOTP secret and the row across reruns, with a new password', async () => {
    const f = fakeDb()
    const first = await provisionOperator(f.db)
    const second = await provisionOperator(f.db)
    expect(f.users).toHaveLength(1)
    expect(second.userId).toBe(first.userId)
    expect(second.totpSecret).toBe(first.totpSecret)
    expect(second.password).not.toBe(first.password)
    expect(await bcrypt.compare(second.password, f.users[0]!.password)).toBe(true)
  })

  it.each([
    ['no marker', null],
    ['another marker', 'credaflow-demo'],
  ])('refuses a database with %s, before any write', async (_label, marker) => {
    const f = fakeDb({ marker })
    await expect(provisionOperator(f.db)).rejects.toThrow(/not the demo-sim database/)
    expect(f.writes()).toBe(0)
  })

  it('refuses when the tenant already has another SUPER_ADMIN', async () => {
    const f = fakeDb({ users: [user({ email: 'other.operator@example.invalid', role: 'SUPER_ADMIN' })] })
    await expect(provisionOperator(f.db)).rejects.toThrow(/already has another SUPER_ADMIN/)
    expect(f.writes()).toBe(0)
  })

  it.each([
    ['another role', { role: 'ADMIN' }],
    ['another tenant', { role: 'SUPER_ADMIN', tenantId: 't-other' }],
    ['no tenant', { role: 'SUPER_ADMIN', tenantId: null }],
  ])('refuses when the operator email exists with %s', async (_label, over) => {
    const f = fakeDb({ users: [user({ email: STAFF.operator.email, ...over })] })
    await expect(provisionOperator(f.db)).rejects.toThrow(/exists as/)
    expect(f.writes()).toBe(0)
  })
})

describe('parseOperatorCredentials', () => {
  const good = { userId: 'u-1', email: STAFF.operator.email, password: 'pw', totpSecret: 'SECRET' }

  it('reads the last line of the container output', () => {
    expect(parseOperatorCredentials(`progress line\n${JSON.stringify(good)}\n`)).toEqual(good)
  })

  it.each([
    ['empty input', ''],
    ['not JSON', 'Seed refused: something\n'],
    ['JSON that is not an object', '"text"\n'],
    ['another email', JSON.stringify({ ...good, email: 'admin@acme-lending.example' })],
    ['no password', JSON.stringify({ ...good, password: '' })],
    ['no TOTP secret', JSON.stringify({ ...good, totpSecret: undefined })],
    ['no user id', JSON.stringify({ ...good, userId: 7 })],
  ])('rejects %s', (_label, text) => {
    expect(() => parseOperatorCredentials(text)).toThrow(/does not hold the operator's credentials/)
  })
})

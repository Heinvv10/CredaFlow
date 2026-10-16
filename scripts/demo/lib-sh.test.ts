import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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

import { spawnSync } from 'node:child_process'
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

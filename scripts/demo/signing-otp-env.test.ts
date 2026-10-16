import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

// The two things the bake's agreement and mandate signing need from the sim
// stack's environment (scenarios/signing.ts). Without either, every persona
// fails at origination-13-agreement with POST /api/signing-otp → 502:
//   - UNSUB_TOKEN_SECRET: the signing-OTP email is a redacted template, which
//     sendMessage refuses before any provider without it
//     (assertRedactedSendIsRecoverable, lib/messaging/send.ts);
//   - DEMO_MODE=true on the sim app: the simulator signs with the code the
//     route reveals for a .invalid mailbox (demoCodeReveal), never by reading
//     the sink. lib/signing-otp/email-delivery.integration.test.ts proves both
//     against a real database and the sim's SMTP sink.

const LIB = join(__dirname, 'lib.sh')
const COMPOSE = join(__dirname, '..', '..', 'docker-compose.demo-sim.yml')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('ensure_shared_secrets', () => {
  it('creates UNSUB_TOKEN_SECRET in a secrets file that lacks it, and keeps it on a second run', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'demo-secrets-'))
    dirs.push(dataDir)
    const file = join(dataDir, 'secrets.env')
    // The fictional collection account is added by hand, never generated.
    writeFileSync(file, [
      'DEBIT_MANDATE_CREDITOR_BANK_NAME=Synthetic Bank',
      'DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER=0000000000',
      'DEBIT_MANDATE_CREDITOR_BRANCH_CODE=000000',
      '',
    ].join('\n'), { mode: 0o600 })
    const run = () => spawnSync('bash', ['-c', '. "$0"; ensure_shared_secrets', LIB], {
      encoding: 'utf8', env: { ...process.env, DEMO_DATA_DIR: dataDir },
    })

    const first = run()
    expect(first.status, first.stderr).toBe(0)
    const secret = parseEnv(readFileSync(file, 'utf8')).UNSUB_TOKEN_SECRET
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    expect(run().status).toBe(0)
    expect(parseEnv(readFileSync(file, 'utf8')).UNSUB_TOKEN_SECRET).toBe(secret)
  })
})

/**
 * The `environment:` mapping of one service in a compose file, read by
 * indentation (no YAML parser is a declared dependency). Only plain
 * `KEY: value` entries, the value bare, "double" or 'single' quoted, with an
 * optional trailing `# comment`; merge keys and comment lines are skipped.
 */
function serviceEnvironment(yaml: string, service: string): Record<string, string> {
  const lines = yaml.split('\n')
  const start = lines.indexOf(`  ${service}:`)
  if (start < 0) throw new Error(`no service ${service}`)
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l))
  const block = lines.slice(start + 1, end < 0 ? undefined : end)
  const envAt = block.indexOf('    environment:')
  if (envAt < 0) throw new Error(`service ${service} has no environment mapping`)
  const env: Record<string, string> = {}
  for (const line of block.slice(envAt + 1)) {
    if (!/^ {6}/.test(line)) break
    const m = /^ {6}([A-Z0-9_]+):\s*("[^"]*"|'[^']*'|[^#\s][^#]*?)?\s*(#.*)?$/.exec(line)
    if (m) env[m[1]] = (m[2] ?? '').replace(/^(["'])(.*)\1$/, '$2')
  }
  return env
}

describe('serviceEnvironment', () => {
  it.each([
    ['DEMO_MODE: "true"'],
    ["DEMO_MODE: 'true'"],
    ['DEMO_MODE: true'],
    ['DEMO_MODE: "true"  # reveal codes'],
    ['DEMO_MODE: true # reveal codes'],
  ])('reads %s as true', (entry) => {
    const yaml = ['services:', '  app:', '    environment:', '      <<: *x', '      # note', `      ${entry}`, '  db:', '    environment:', '      DEMO_MODE: "false"'].join('\n')
    expect(serviceEnvironment(yaml, 'app').DEMO_MODE).toBe('true')
  })
})

describe('docker-compose.demo-sim.yml', () => {
  it('runs the sim app with DEMO_MODE exactly "true"', () => {
    expect(serviceEnvironment(readFileSync(COMPOSE, 'utf8'), 'app').DEMO_MODE).toBe('true')
  })
})

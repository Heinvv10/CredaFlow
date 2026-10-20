import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// WA_ENABLED unset defers to the tenant's whatsappEnabled (lib/whatsapp/
// env-switch.ts), so a non-production stack restored from or baked off real
// data would message real borrowers unless the repo itself pins WhatsApp off.
// The pin lives in the compose `environment:` (which beats any untracked
// env_file) rather than in env files outside the repo. Real-lender
// provisioning must set nothing: Cloud lenders never set WA_ENABLED.

const ROOT = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** The `environment:` mapping lines of one top-level service. */
function serviceEnvLines(yaml: string, service: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.findIndex((l) => l === `  ${service}:`)
  if (start < 0) throw new Error(`no service ${service}`)
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l))
  const block = lines.slice(start + 1, end < 0 ? undefined : end)
  const envAt = block.indexOf('    environment:')
  if (envAt < 0) throw new Error(`service ${service} has no environment mapping`)
  const out: string[] = []
  for (const line of block.slice(envAt + 1)) {
    if (!/^ {6}/.test(line)) break
    out.push(line)
  }
  return out
}

const waEnabledOf = (lines: string[]) =>
  lines.map((l) => /^ {6}WA_ENABLED:\s*["']?([^"'#\s]*)["']?/.exec(l)?.[1]).find((v) => v !== undefined)

describe('non-production stacks pin WA_ENABLED=false in the repo', () => {
  it.each([
    ['docker-compose.demo-sim.yml'],
    ['docker-compose.staging.yml'],
  ])('%s sets the app service WA_ENABLED to exactly "false"', (file) => {
    expect(waEnabledOf(serviceEnvLines(read(file), 'app'))).toBe('false')
  })

  it('the simulator seed container is pinned off as well', () => {
    expect(read('scripts/demo/sim/seed-faked.sh')).toMatch(/^\s*-e WA_ENABLED=false \\$/m)
  })

  it('the parser reads the pin the way the tests assume', () => {
    expect(waEnabledOf(['      A: "x"', '      WA_ENABLED: "false"  # off'])).toBe('false')
    expect(waEnabledOf(['      A: "x"'])).toBeUndefined()
  })
})

describe('real-lender provisioning sets nothing', () => {
  it.each([
    ['scripts/lender/provision-lender.sh'],
    ['scripts/lender/docker-compose.lender.yml'],
    ['.env.example'],
  ])('%s does not set WA_ENABLED, so a Cloud lender keeps sending', (file) => {
    expect(read(file)).not.toMatch(/^\s*(-e\s+|export\s+)?WA_ENABLED\b/m)
  })
})

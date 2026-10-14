import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commits, git, installStackHooks, live, liveEnv, repo, root, run, short } from './upgrade-stack.harness'

// build-image.sh against the docker/npx stubs of upgrade-stack.harness.ts: its
// default naming and build call, and the DEMO_BUILD_ROOT / DEMO_IMAGE_NAME overrides
// upgrade-stack.sh uses.

installStackHooks()

const build = (env: Record<string, string> = {}) => run([], { LIVE_DIR: live, ...env }, 'build-image.sh')
const asLender = (slug: string) =>
  writeFileSync(join(live, '.env'), liveEnv().replace('NEXT_PUBLIC_TENANT_SLUG=acme', `NEXT_PUBLIC_TENANT_SLUG=${slug}`))

describe('build-image.sh', () => {
  it('names the image after the lender and the checkout, exactly as before', () => {
    const r = build()
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`credaflow:demo-${short('c3')}`)
    const call = r.calls.find((c) => c.startsWith('docker build'))!
    expect(call).toMatch(new RegExp(
      `^docker build -f ${repo}/Dockerfile -t credaflow:demo-${short('c3')} --build-arg GIT_SHA=${short('c3')} ` +
      '--build-arg BUILD_TIME=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ --build-arg NEXT_PUBLIC_TENANT_SLUG=acme ' +
      '--build-arg NEXT_PUBLIC_PORTAL_LOGIN_URL=https://fairscore.example.invalid/portal/login ' +
      `--build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA ${repo}$`))
  })

  it('prefixes a lender other than acme with its name', () => {
    asLender('fairscore')
    const r = build({ DEMO_LENDER: 'fairscore' })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`credaflow:fairscore-${short('c3')}`)
    expect(r.calls.find((c) => c.startsWith('docker build'))).not.toContain('--label')
  })

  it('builds another tree under another name, labelled with the tenant slug, when DEMO_BUILD_ROOT and DEMO_IMAGE_NAME are set', () => {
    const tree = join(root, 'other-tree')
    git(repo, 'worktree', 'add', '-q', '--detach', tree, commits.c2!)
    asLender('fairscore')
    const r = build({ DEMO_LENDER: 'fairscore', DEMO_BUILD_ROOT: tree, DEMO_IMAGE_NAME: 'credaflow:custom-1' })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('credaflow:custom-1')
    const call = r.calls.find((c) => c.startsWith('docker build'))!
    expect(call).toContain(`-f ${tree}/Dockerfile -t credaflow:custom-1 --build-arg GIT_SHA=${short('c2')} `)
    expect(call).toContain('--label credaflow.tenant_slug=fairscore')
    expect(call.endsWith(` ${tree}`)).toBe(true)
  })

  it('ignores the old BUILD_ROOT / IMAGE_NAME names', () => {
    const r = build({ BUILD_ROOT: join(root, 'nowhere'), IMAGE_NAME: 'credaflow:custom-1' })
    expect(r.stdout.trim()).toBe(`credaflow:demo-${short('c3')}`)
  })
})

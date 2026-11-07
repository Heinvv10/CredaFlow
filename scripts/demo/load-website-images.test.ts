import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// load-website-images.sh against a stubbed docker: the files the loader writes must be
// owned by the app user (the app container's own uid:gid, never the host's) and land in
// the stack's uploads volume, on its network, against its database, and only for a demo
// stack. The real thing is exercised against a throwaway postgres + volume by hand.

const DEMO = __dirname
let root: string
let log: string

const stub = (name: string, body: string) => {
  mkdirSync(join(root, 'bin'), { recursive: true })
  writeFileSync(join(root, 'bin', name), body)
  chmodSync(join(root, 'bin', name), 0o755)
}

function load(env: Record<string, string> = {}, args: string[] = ['nairobi-stack', 'nairobi', join(root, 'images')]) {
  const r = spawnSync('bash', [join(root, 'repo', 'scripts', 'demo', 'load-website-images.sh'), ...args], {
    timeout: 20_000, encoding: 'utf8',
    env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: root, STUB_LOG: log, STUB_CHECK_EXIT: '0', ...env },
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, 'utf8').split('\n') }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'load-images-'))
  log = join(root, 'calls.log')
  writeFileSync(log, '')
  mkdirSync(join(root, 'repo', 'scripts', 'demo'), { recursive: true })
  mkdirSync(join(root, 'repo', 'node_modules', '@prisma', 'client'), { recursive: true })
  mkdirSync(join(root, 'images'))
  copyFileSync(join(DEMO, 'load-website-images.sh'), join(root, 'repo', 'scripts', 'demo', 'load-website-images.sh'))
  stub('npx', '#!/bin/sh\necho "npx $*" >> "$STUB_LOG"\nexit "$STUB_CHECK_EXIT"\n')
  stub('docker', String.raw`#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
mode="$STUB_DEMO_MODE"; [ -n "$mode" ] || mode=true
case "$1" in
  inspect)
    case "$*" in
      *"{{range .Config.Env}}"*) printf 'PATH=/usr/bin\nDEMO_MODE=%s\nDATABASE_URL=postgresql://u:secret-pw@db:5432/app\n' "$mode" ;;
      *".Destination"*) echo nairobi-stack_uploads ;;
      *".NetworkSettings.Networks"*) echo nairobi-stack_default ;;
    esac ;;
  exec) case "$*" in *"id -u"*) echo 1001 ;; *"id -g"*) echo 1002 ;; esac ;;
esac
exit 0
`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('load-website-images.sh', () => {
  it("runs the loader as the app container's uid:gid, with the stack's uploads volume and network, and the directory read-only", () => {
    const r = load()
    expect(r.status).toBe(0)
    const run = r.calls.find((l) => l.startsWith('docker run '))!
    expect(run).toContain('--user 1001:1002')
    expect(run).toContain('--network nairobi-stack_default')
    expect(run).toContain('-v nairobi-stack_uploads:/w/uploads')
    expect(run).toContain(`-v ${join(root, 'images')}:${join(root, 'images')}:ro`)
    expect(run).toContain('-e DEMO_MODE=true')
    expect(run).toContain(`scripts/demo/set-website-images.ts nairobi ${join(root, 'images')}`)
    expect(run).not.toContain('secret-pw') // the URL goes in by name, never in argv
  })

  it('refuses a stack that is not DEMO_MODE=true, before running anything in it', () => {
    const r = load({ STUB_DEMO_MODE: 'false' })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('not DEMO_MODE=true')
    expect(r.calls.some((l) => l.startsWith('docker run '))).toBe(false)
  })

  it('checks the directory first and refuses a bad one without touching the stack', () => {
    const r = load({ STUB_CHECK_EXIT: '2' })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('not a valid image directory')
    expect(r.calls.some((l) => l.startsWith('docker run ') || l.startsWith('docker build'))).toBe(false)
  })

  it('refuses a missing directory and wrong usage', () => {
    expect(load({}, ['nairobi-stack', 'nairobi', join(root, 'nope')]).out).toContain('is not a directory')
    expect(load({}, ['nairobi-stack']).status).not.toBe(0)
  })
})

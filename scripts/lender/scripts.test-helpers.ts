import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, vi } from "vitest"

// Fixture for the lender shell-script tests (scripts.test.ts, scripts-provision.test.ts).
// docker, curl and sleep are shell stubs on PATH that answer what the scripts ask and log
// every call; gpg and flock are real. The scripts are copied into a throwaway git repo so
// their REPO_ROOT (the checkout they build from) is under test control. The real Docker run
// is the proof in docs/DEPLOY.md; these tests pin the ORDER and the GUARDS.
// The scripts shell out to gpg, flock and real sleeps; a loaded build host needs more than the default 5 s.
vi.setConfig({ testTimeout: 60_000 })
// Importing this module registers the beforeEach/afterEach that rebuild the fixture.

export const SRC = __dirname
export let root: string
export let repo: string
export let lender: string
export let log: string

const DOCKER = String.raw`#!/bin/sh
# compose runs under env -i, so the STUB_* settings reach the stubs through a file
[ -f "$HOME/stub.env" ] && . "$HOME/stub.env"
echo "$* APP_IMAGE=$APP_IMAGE" >> "$STUB_LOG"
if [ -n "$STUB_FAIL_MATCH" ]; then case "$*" in *"$STUB_FAIL_MATCH"*) exit 1 ;; esac; fi
case "$*" in
  "compose version") exit 0 ;;
  "image inspect -f {{.Id}} "*) echo "sha256:id-$(echo "$5" | tr ':/' '__')$STUB_ID_SUFFIX" ;;
  "image inspect -f {{index .Config.Labels"*) s="$STUB_IMAGE_SLUG"; [ -n "$s" ] || s=stub-lender; if [ "$s" = NONE ]; then echo; else echo "$s"; fi ;;
  *"config --format json"*)
    e="$STUB_LENDER"; g() { sed -n "s/^$1=//p" "$e/$2" | head -1; }
    bind="$(g APP_BIND .env)"; [ -n "$bind" ] || bind=127.0.0.1
    jq -n --arg s "$(g STAFF_AUTH_SECRET secrets/auth.env)" --arg p "$(g PORTAL_AUTH_SECRET secrets/auth.env)" --arg sh "$(g NEXTAUTH_SECRET .env)" \
      --arg b "$bind" --arg ap "$(g APP_PORT .env)" --arg pp "$(g PORTAL_PORT .env)" --arg leak "$(g STAFF_AUTH_SECRET .env)" \
      '{services:{db:{}, app:{environment:({AUTH_SECRET:$s,NEXTAUTH_SECRET:$sh} + (if $leak != "" then {STAFF_AUTH_SECRET:$leak} else {} end)), ports:[{host_ip:$b,published:$ap}]}, "app-portal":{environment:{AUTH_SECRET:$p,NEXTAUTH_SECRET:$sh}, ports:[{host_ip:$b,published:$pp}]}}}' ;;
  "image inspect -f "*) case "$*" in *new*) echo "GIT_SHA=$STUB_COMMIT_NEW" ;; *) echo "GIT_SHA=$STUB_COMMIT_OLD" ;; esac ;;
  "image inspect "*) exit 0 ;;
  "ps -a -q "*) echo "$STUB_OUR_CONTAINER" ;;
  "inspect -f {{range"*) echo "$STUB_PS_PORTS" ;;
  "ps -a "*) [ -z "$STUB_PROJECT_DIR" ] || { [ "$STUB_PROJECT_DIR" = BLANK ] && echo "dir=" || echo "dir=$STUB_PROJECT_DIR"; } ;;
  "volume ls"*|"network ls"*) [ -z "$STUB_FOREIGN_VOLUME" ] || echo "$STUB_FOREIGN_VOLUME" ;;
  "ps -q "*) echo "$STUB_SERVING" ;;
  "build "*) for last in "$@"; do :; done; { echo "ARGS: $*"; find "$last" -type f | sed "s|^$last/||" | sort; } >> "$STUB_LOG.build" ;;
  *"up -d --no-deps"*) if grep -qE "bad|upfail" "$STUB_LENDER/state/image.env" 2>/dev/null; then exit 1; fi ;;
  *"pg_dump"*) printf 'PGDMP-stub-%s' "$$" ;;
  *"lender-counts"*) printf 'Tenant=1\nUser=1\nmigrations=5\n' ;;
  *"pg_restore --list"*) d="$(cat)"; case "$d" in PGDMP*) ;; *) exit 1 ;; esac ;;
  *"pg_restore"*) cat > /dev/null ;;
  *"u.role = 'SUPER_ADMIN'"*) echo 1 ;;
  *"to_regclass"*) echo "$STUB_HAS_MIGRATIONS" ;;
  *"FILTER"*) echo "0 5" ;;
  *"Tenant="*) printf 'Tenant=1\nUser=1\nmigrations=5\n' ;;
  "run --rm "*) exit "$STUB_MIGRATE_RC" ;;
esac
exit 0
`
// Health follows whichever image state/image.env currently names: "bad" images never answer.
const CURL = String.raw`#!/bin/sh
[ -f "$HOME/stub.env" ] && . "$HOME/stub.env"
echo "curl $*" >> "$STUB_LOG"
case "$*" in *"-w "*) if [ -n "$STUB_PAGE_CODE" ]; then printf '%s' "$STUB_PAGE_CODE"; else printf 200; fi; exit 0 ;; esac
img="$(sed -n 's/^APP_IMAGE=//p' "$STUB_LENDER/state/image.env" 2>/dev/null)"
case "$img" in *bad*) exit 22 ;; *new*) h="$STUB_HEALTH_COMMIT"; [ -n "$h" ] || h="$STUB_COMMIT_NEW"; st="$STUB_HEALTH_STATUS"; [ -n "$st" ] || st=ok; echo "{\"status\":\"$st\",\"commit\":\"$h\"}" ;; *) echo "{\"status\":\"ok\",\"commit\":\"$STUB_COMMIT_OLD\"}" ;; esac
`

export function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const stubEnv = { STUB_LOG: log, STUB_LENDER: lender, STUB_COMMIT_NEW: "newsha", STUB_COMMIT_OLD: "oldsha", STUB_HAS_MIGRATIONS: "t", STUB_MIGRATE_RC: "0", ...env }
  writeFileSync(join(root, "stub.env"), Object.entries(stubEnv).filter(([k]) => k.startsWith("STUB_")).map(([k, v]) => `export ${k}='${v}'`).join("\n"))
  const r = spawnSync("bash", [join(repo, "scripts/lender", cmd), ...args], {
    env: {
      NODE_ENV: "test", PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, HOME: root, GNUPGHOME: join(root, "gnupg"),
      STUB_LOG: log, STUB_LENDER: lender, STUB_COMMIT_NEW: "newsha", STUB_COMMIT_OLD: "oldsha",
      STUB_HAS_MIGRATIONS: "t", STUB_MIGRATE_RC: "0", ...env,
    },
    encoding: "utf8",
    cwd: root,
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, "utf8").split("\n") }
}
export const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" })
export const state = (f: string) => (existsSync(join(lender, "state", f)) ? readFileSync(join(lender, "state", f), "utf8").trim() : null)
export const idx = (calls: string[], needle: string) => calls.findIndex((c) => c.includes(needle))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lender-sh-"))
  repo = join(root, "repo"); lender = join(root, "lender"); log = join(root, "docker.log")
  mkdirSync(join(repo, "scripts"), { recursive: true }); mkdirSync(join(root, "bin")); mkdirSync(join(root, "gnupg"), { mode: 0o700 })
  cpSync(SRC, join(repo, "scripts/lender"), { recursive: true, filter: (s) => !s.endsWith(".test.ts") })
  writeFileSync(log, "")
  for (const [n, body] of [["docker", DOCKER], ["curl", CURL], ["sleep", "#!/bin/sh\nexit 0\n"]]) {
    writeFileSync(join(root, "bin", n), body); chmodSync(join(root, "bin", n), 0o755)
  }
  git("init", "-q"); git("add", "scripts"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
  mkdirSync(join(lender, "secrets"), { recursive: true }); mkdirSync(join(lender, "backups")); mkdirSync(join(lender, "state"))
  writeFileSync(join(lender, "secrets/backup.passphrase"), "test-passphrase\n")
  writeFileSync(join(lender, ".env"), "NEXT_PUBLIC_TENANT_SLUG=stub-lender\nPOSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=p\nAPP_PORT=3999\nPORTAL_PORT=3998\nNEXTAUTH_SECRET=shared-secret-0123456789abcdef0123456789\n")
  writeFileSync(join(lender, "secrets/auth.env"), `STAFF_AUTH_SECRET=${"s".repeat(40)}\nPORTAL_AUTH_SECRET=${"p".repeat(40)}\n`)
  writeFileSync(join(lender, "docker-compose.yml"), "services: {}\n")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))


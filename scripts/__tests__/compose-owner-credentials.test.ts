import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The owner database login (it migrates and owns the audit tables) must not reach the app
 * containers, or the two-login split protects nothing: a process that holds the owner password
 * can switch the append-only triggers off. Both compose files load an env file into `app` and
 * `app-portal`; they blank the owner variables in `environment:`. This renders each file with
 * real compose and an env file that DOES carry owner secrets, and reads what the app services get.
 */
const compose = spawnSync("sh", ["-c", "docker compose version >/dev/null 2>&1 && echo 'docker compose' || (docker-compose version >/dev/null 2>&1 && echo docker-compose)"], { encoding: "utf8" }).stdout.trim()
const ROOT = join(__dirname, "../..")
const OWNER_SECRET = "owner-secret-never-in-an-app"
const OWNER_ENV = `POSTGRES_USER=ownerlogin\nPOSTGRES_PASSWORD=${OWNER_SECRET}\nPOSTGRES_DB=d\nMIGRATE_DATABASE_URL=postgresql://ownerlogin:${OWNER_SECRET}@db/d\nOWNER_DATABASE_URL=postgresql://ownerlogin:${OWNER_SECRET}@db/d\n`

type Service = { environment?: Record<string, string> }

function render(source: string, envFile: string, extraEnv: Record<string, string>): Record<string, Service> {
  const dir = mkdtempSync(join(tmpdir(), "compose-owner-"))
  try {
    cpSync(join(ROOT, source), join(dir, "docker-compose.yml"))
    writeFileSync(join(dir, envFile), OWNER_ENV)
    const [bin, ...sub] = compose.split(" ")
    const r = spawnSync(bin, [...sub, "-p", "x", "-f", join(dir, "docker-compose.yml"), "--project-directory", dir, "config", "--format", "json"], {
      env: {
        ...process.env, APP_IMAGE: "cf:x", APP_PORT: "3999", PORTAL_PORT: "3998", PORTAL_NEXTAUTH_URL: "https://portal.example", PORTAL_AUTH_URL: "https://portal.example",
        STAFF_AUTH_SECRET: "staff-secret", PORTAL_AUTH_SECRET: "portal-secret", NEXTAUTH_SECRET: "s", NEXT_PUBLIC_TENANT_SLUG: "x",
        POSTGRES_USER: "ownerlogin", POSTGRES_PASSWORD: OWNER_SECRET, POSTGRES_DB: "d", APP_DB_USER: "app_u", APP_DB_PASSWORD: "appp", ...extraEnv,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    })
    expect(r.status, r.stderr).toBe(0)
    return (JSON.parse(r.stdout) as { services: Record<string, Service> }).services
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!compose)("owner database credentials stay out of the app containers", () => {
  for (const [source, envFile] of [["docker-compose.yml", ".env.production"], ["scripts/lender/docker-compose.lender.yml", ".env"]] as const) {
    it(`${source}: app and app-portal get the application's login, and no owner variable`, () => {
      const services = render(source, envFile, {})
      for (const name of ["app", "app-portal"]) {
        const env = services[name].environment ?? {}
        expect(env.DATABASE_URL, name).toMatch(/^postgresql:\/\/app_u:appp@db:5432\/d\?/)
        for (const key of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "MIGRATE_DATABASE_URL", "OWNER_DATABASE_URL"]) {
          expect(env[key] ?? "", `${name} ${key}`).toBe("")
        }
        expect(JSON.stringify(services[name]), name).not.toContain(OWNER_SECRET)
      }
    })

    it(`${source}: still renders for ps/logs before a stack has its own login, but the app gets no owner login unless a demo/legacy stack says so`, () => {
      const dir = mkdtempSync(join(tmpdir(), "compose-fallback-"))
      try {
        cpSync(join(ROOT, source), join(dir, "docker-compose.yml"))
        writeFileSync(join(dir, envFile), OWNER_ENV)
        const url = (allow: boolean) => {
          const env = { ...process.env }
          for (const k of ["APP_DB_USER", "APP_DB_PASSWORD", "AUDIT_ALLOW_PRIVILEGED_DB_ROLE"]) delete env[k]
          const [bin, ...sub] = compose.split(" ")
          const r = spawnSync(bin, [...sub, "-p", "x", "-f", join(dir, "docker-compose.yml"), "--project-directory", dir, "config", "--format", "json"], {
            env: { ...env, APP_IMAGE: "cf:x", APP_PORT: "3999", PORTAL_PORT: "3998", PORTAL_NEXTAUTH_URL: "https://portal.example", PORTAL_AUTH_URL: "https://portal.example",
              STAFF_AUTH_SECRET: "staff-secret", PORTAL_AUTH_SECRET: "portal-secret", NEXTAUTH_SECRET: "s", NEXT_PUBLIC_TENANT_SLUG: "x",
              POSTGRES_USER: "ownerlogin", POSTGRES_PASSWORD: OWNER_SECRET, POSTGRES_DB: "d", ...(allow ? { AUDIT_ALLOW_PRIVILEGED_DB_ROLE: "1" } : {}) },
            encoding: "utf8",
          })
          expect(r.status, r.stderr).toBe(0)
          return (JSON.parse(r.stdout) as { services: Record<string, Service> }).services.app.environment?.DATABASE_URL
        }
        expect(url(false)).toMatch(/^postgresql:\/\/:@db:/) // no user, no password: it cannot connect
        expect(url(false)).not.toContain(OWNER_SECRET)
        expect(url(true)).toMatch(/^postgresql:\/\/ownerlogin:/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it(`${source}: the database container still gets the owner login`, () => {
      expect(JSON.stringify(render(source, envFile, {}).db)).toContain(OWNER_SECRET)
    })
  }
})

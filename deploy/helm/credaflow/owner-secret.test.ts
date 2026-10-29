import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The owner database login must not be in a Secret the web or worker pods mount. helm is not
 * run by the unit suite (deploy-lint.yml renders the chart and asserts the refusals), so this
 * reads the chart: the defaults keep the owner Secret apart, and the guard that fails the render
 * is wired into both templates that read it.
 */
const read = (f: string) => readFileSync(path.join(__dirname, f), "utf8")
const values = read("values.yaml")

function block(name: string): string {
  const m = new RegExp(`^${name}:\\n((?:[ \\t].*\\n|\\n)*)`, "m").exec(values)
  return m?.[1] ?? ""
}

describe("chart: the owner database login", () => {
  it("defaults to a Secret the pods do not mount", () => {
    const owner = /databaseUrlSecret:\n\s+name: (\S+)/.exec(block("migrate"))?.[1]
    const mounted = [...block("existingSecrets").matchAll(/^\s*- (\S+)/gm)].map((m) => m[1])
    const crons = /secret:\n\s+name: (\S+)/.exec(block("externalCrons"))?.[1]
    expect(owner).toBe("credaflow-migrate")
    expect(mounted).not.toContain(owner)
    expect(crons).not.toBe(owner)
  })

  it("has a render guard that fails when the owner Secret is pod-mounted or cron-shared, used by both Jobs", () => {
    const helpers = read("templates/_helpers.tpl")
    expect(helpers).toMatch(/define "credaflow.assertOwnerSecretApart"/)
    expect(helpers).toMatch(/has \$owner \.Values\.existingSecrets/)
    expect(helpers).toMatch(/eq \$owner \.Values\.externalCrons\.secret\.name/)
    expect((helpers.match(/fail /g) ?? []).length).toBeGreaterThanOrEqual(3)
    for (const f of ["templates/migrate-job.yaml", "templates/app-role-job.yaml"]) expect(read(f), f).toContain('include "credaflow.assertOwnerSecretApart"')
  })

  it("lets the worker mount its own Secrets instead of the shared list, and never the owner's", () => {
    const helpers = read("templates/_helpers.tpl")
    expect(helpers).toMatch(/default \.root\.Values\.existingSecrets \.secrets/)
    expect(helpers).toMatch(/define "credaflow.assertWorkerSecretsApart"/)
    expect(read("templates/worker-deployment.yaml")).toContain('"secrets" .Values.worker.existingSecrets')
    expect(read("templates/web-deployment.yaml")).not.toContain("worker.existingSecrets")
    expect(block("worker")).toMatch(/existingSecrets: \[\]/)
  })

  it("passes no password on a command line: the role Job and compose pipe \\set lines to psql's stdin", () => {
    const job = read("templates/app-role-job.yaml")
    expect(job).toContain("| psql \"$url\" -v ON_ERROR_STOP=1 -f -")
    expect(job).not.toMatch(/-v app_password|-v worker_password/)
  })

  it("is not read by any pod template", () => {
    for (const f of ["web-deployment.yaml", "worker-deployment.yaml", "external-crons.yaml"]) expect(read(`templates/${f}`), f).not.toMatch(/databaseUrlSecret/)
  })
})

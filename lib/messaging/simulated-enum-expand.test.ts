import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { readBaselineSql } from "../db-baseline.test-helpers"

const schema = readFileSync("prisma/schema.prisma", "utf8")

function enumMembers(name: string): string[] {
  const body = schema.match(new RegExp(`enum\\s+${name}\\s*\\{([\\s\\S]*?)\\}`))?.[1]
  if (!body) throw new Error(`Enum ${name} is missing from prisma/schema.prisma`)
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
}

function baselineEnumMembers(name: string): string[] {
  const body = readBaselineSql().match(new RegExp(`^CREATE TYPE "${name}" AS ENUM \\(([^;]*)\\);`, "m"))?.[1]
  if (!body) throw new Error(`Enum ${name} is missing from the baseline migration`)
  return body.split(",").map((member) => member.trim().replace(/^'|'$/g, ""))
}

describe("SIMULATED message status", () => {
  it("orders SIMULATED directly after SENT in the schema and the database", () => {
    expect(enumMembers("MsgStatus").slice(0, 4)).toEqual([
      "QUEUED",
      "SENT",
      "SIMULATED",
      "DELIVERED",
    ])
    expect(baselineEnumMembers("MsgStatus").slice(0, 4)).toEqual([
      "QUEUED",
      "SENT",
      "SIMULATED",
      "DELIVERED",
    ])
  })
})

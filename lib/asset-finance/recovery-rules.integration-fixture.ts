/**
 * Helpers for the slice 4a rule suites: a rule as the one statement or clause
 * of a trigger function that refuses (removed with `raiseOff` / `clauseOff`),
 * a trigger, a CHECK or an index, and `rules(db)`, which binds the shared
 * ruleRefuses / ruleAdmits mutation proof to a client. Where a second rule
 * would refuse the same attack (defence in depth), `also` takes it out too so
 * the first is shown to be a refuser in its own right. Not a test file.
 */
import type { PrismaClient } from "@prisma/client"
import { expect } from "vitest"
import { attempt, ruleAdmits, type DbRule } from "./lease-servicing.integration-fixture"

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

/** What replaces a refused DELETE once its rule is gone: the row goes. */
export const PASS_DELETE = "IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;"

/** The RAISE with this literal message, replaced by a no-op (or `replacement`): the rule it enforced no longer exists. */
export const raiseOff = (fn: string, message: string, replacement = "NULL;"): DbRule => ({
  fn, replace: [`RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = '${message.replaceAll("'", "''")}';`, replacement],
})

/** One exact clause of a trigger function, replaced (`with` defaults to nothing). */
export const clauseOff = (fn: string, clause: string, replacement = ""): DbRule => ({ fn, replace: [clause, replacement] })

/** Test setup inside an attack: row triggers off (CHECKs and indexes still bind) until `triggersOn`. */
export const triggersOff = (tx: Tx) => tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
export const triggersOn = (tx: Tx) => tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")

async function takeOut(tx: Tx, rule: DbRule): Promise<void> {
  if ("fn" in rule) {
    const [row] = await tx.$queryRawUnsafe<{ def: string }[]>(`SELECT pg_get_functiondef('public."${rule.fn}"'::regproc) AS def`)
    const [clause, replacement] = rule.replace
    const found = row.def.split(clause).length - 1
    if (found !== 1) throw new Error(`${rule.fn}: the clause must occur exactly once, found ${found}: ${clause}`)
    await tx.$executeRawUnsafe(row.def.replace(clause, () => replacement))
  } else if ("trigger" in rule) await tx.$executeRawUnsafe(`ALTER TABLE "${rule.table}" DISABLE TRIGGER "${rule.trigger}"`)
  else if ("constraint" in rule) await tx.$executeRawUnsafe(`ALTER TABLE "${rule.table}" DROP CONSTRAINT "${rule.constraint}"`)
  else await tx.$executeRawUnsafe(`DROP INDEX "${rule.index}"`)
}

export function rules(db: () => PrismaClient) {
  return {
    /** The rule refuses the attack, and is what refuses it: without it (and the `also` rules), the attack goes through. */
    async refuses(rule: DbRule, message: RegExp, attack: (tx: Tx) => Promise<unknown>, also: DbRule[] = []): Promise<void> {
      const refused = await attempt(db(), attack)
      if (!message.test(refused)) throw new Error(`expected a refusal matching ${message}, got: ${refused}`)
      const without = await attempt(db(), async (tx) => {
        for (const other of also) await takeOut(tx, other)
        await attack(tx)
      }, rule)
      if (without !== "ok") throw new Error(`without ${JSON.stringify(rule)}${also.length ? ` and ${JSON.stringify(also)}` : ""} the attack should go through, got: ${without}`)
    },
    /** The control: the database admits it as it is. */
    admits: (attack: (tx: Tx) => Promise<unknown>) => ruleAdmits(db(), attack),
    /** Whatever the database says to an attack: "ok" or the refusal. */
    refusal: (attack: (tx: Tx) => Promise<unknown>) => attempt(db(), attack),
    expectRefusal: async (message: RegExp, attack: (tx: Tx) => Promise<unknown>) => expect(await attempt(db(), attack)).toMatch(message),
  }
}

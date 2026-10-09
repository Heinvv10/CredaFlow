import { describe, expect, it } from "vitest"
import { BAD, CASES, GOOD, evalKnowledge, grade } from "./website-chat-eval"

// The eval's own self-test, run in `npm test`: a grader that lets a known-bad
// reply through would report a green eval that proves nothing.
const knowledge = evalKnowledge()
const byName = (name: string) => {
  const c = CASES.find((x) => x.name === name)
  if (!c) throw new Error(`no eval case named ${name}`)
  return c
}

describe("website chat eval grader", () => {
  it.each(Object.entries(BAD))("fails the BAD reply for %s", (name, reply) => {
    expect(grade(byName(name), reply, knowledge)).not.toEqual([])
  })
  it.each(Object.entries(GOOD))("passes the GOOD reply for %s", (name, reply) => {
    expect(grade(byName(name), reply, knowledge)).toEqual([])
  })
  it("catches a missed hand-off on the handOff check alone", () => {
    expect(grade(byName("existing account → hand off"), BAD["existing account → hand off"], knowledge)).toEqual(["needsHuman=false, expected true"])
  })
})

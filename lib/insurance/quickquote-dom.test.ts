// @vitest-environment jsdom
//
// Per-file, deliberately. The suite default stays `node` (vitest.config.ts):
// ~570 files run under it today and flipping the default to jsdom to serve one
// new file would change the environment every one of them runs in.
//
// This file exists because two independent review rounds found defects in the
// DOM layer and in no other part of the change. The pure bridge functions were
// caught by tests or were right first time; `write` and `checkboxTaken` were
// caught only by someone reading them, because nothing could execute them.

import { beforeEach, describe, expect, it } from "vitest"
import { checkboxTaken, checkedBindingProperty, control, readOptions, write } from "./quickquote-dom"
import { FIELD_NAMES } from "./quickquote-bridge"

/** Minimal stand-in for knockout's `ko.dataFor`. */
function installKo(contexts: Map<Node, Record<string, unknown>>) {
  ;(window as unknown as { ko?: unknown }).ko = {
    dataFor: (node: Node) => contexts.get(node) ?? null,
  }
}

function removeKo() {
  delete (window as unknown as { ko?: unknown }).ko
}

function checkbox(binding?: string): HTMLInputElement {
  const el = document.createElement("input")
  el.type = "checkbox"
  if (binding) el.setAttribute("data-bind", binding)
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  document.body.innerHTML = ""
  removeKo()
})

describe("checkedBindingProperty", () => {
  it("reads FSP's own binding shape", () => {
    expect(checkedBindingProperty("checked: $data.Burglary")).toBe("Burglary")
    expect(checkedBindingProperty("checked: Alarm")).toBe("Alarm")
  })

  /* The attack this anchoring exists for: an unanchored search took the FIRST
     `checked:` anywhere in the attribute, so a nested one inside `attr: {...}`
     won. If that observable happened to be truthy, checkboxTaken confirmed a
     write the real binding never received. */
  it("refuses a binding with a nested checked: rather than picking one", () => {
    expect(
      checkedBindingProperty("attr: { checked: isDefault }, checked: $data.Alarm"),
    ).toBeNull()
  })

  /* `$` is a valid identifier character, so the old pattern captured `$root`
     out of this and then read context["$root"] — undefined — and silently fell
     back to re-reading our own assignment. Returning null is honest; capturing
     the wrong name is not. */
  it.each([
    "checked: $root.policy().Alarm",
    "checked: $parent.Alarm",
    "checked: $data['Alarm']",
    "value: Alarm",
    "",
  ])("returns null for the unrecognised binding %o", (binding) => {
    expect(checkedBindingProperty(binding)).toBeNull()
  })

  /* A quoted delimiter inside a nested object defeats a depth counter that
     does not track string literals: measured, these resolved `isDefault` and
     `wrongOne`, either of which could confirm a write the real binding never
     received. Two `checked:` occurrences now mean "cannot tell" rather than
     "take the first". */
  it.each([
    "attr: { title: 'a)', checked: isDefault, x: 1 }, checked: $data.Alarm",
    "attr: { title: 'a}', checked: isDefault, x: 1 }, checked: $data.Alarm",
    "attr: { 'data-x': ')' , checked: wrongOne , z: 1 }, checked: Alarm",
  ])("refuses the ambiguous binding %o rather than guessing", (binding) => {
    expect(checkedBindingProperty(binding)).toBeNull()
  })

  it("returns null when there is no attribute at all", () => {
    expect(checkedBindingProperty(null)).toBeNull()
  })
})

describe("checkboxTaken", () => {
  it("confirms against FSP's observable, not the property we just assigned", () => {
    const el = checkbox("checked: $data.Burglary")
    const model = { Burglary: () => true }
    installKo(new Map([[el, model]]))
    expect(checkboxTaken(el, true)).toBe(true)
    expect(checkboxTaken(el, false)).toBe(false)
  })

  it("reports a refusal when their model disagrees with the DOM", () => {
    const el = checkbox("checked: $data.Alarm")
    el.checked = true
    // Their binding never fired — the model still holds false.
    installKo(new Map([[el, { Alarm: () => false }]]))
    expect(checkboxTaken(el, true)).toBe(false)
  })

  /* Only a BOOLEAN is interpreted. Every other shape degrades to the DOM
     property, because both ways of coercing one are wrong in opposite
     directions and each reaches a real application:

       `current === want`  refuses a write FSP accepted when they hold 1 or "Y"
       `Boolean(current)`  confirms a write FSP refused when they hold "N",
                           "false" or "0" — all truthy strings meaning no

     Degrading is weaker than a model read and stronger than a guess: it can
     never invent an answer in either direction. */
  it.each([1, "Y", "true", "yes", 0, "", null, "false", "N", "0"])(
    "degrades to the DOM for the non-boolean %o",
    (held) => {
      const ticked = checkbox("checked: $data.Alarm")
      ticked.checked = true
      installKo(new Map([[ticked, { Alarm: () => held }]]))
      expect(checkboxTaken(ticked, true)).toBe(true)

      const unticked = checkbox("checked: $data.Alarm")
      unticked.checked = false
      installKo(new Map([[unticked, { Alarm: () => held }]]))
      expect(checkboxTaken(unticked, true)).toBe(false)
    },
  )

  /* el.checked is set against the grain deliberately: if the model read were
     removed, the DOM fallback would return the opposite of what these expect,
     so the assertions cannot pass without it. */
  it("interprets a real boolean, overriding the DOM", () => {
    const el = checkbox("checked: $data.Alarm")
    el.checked = true
    installKo(new Map([[el, { Alarm: () => false }]]))
    expect(checkboxTaken(el, true)).toBe(false)

    const other = checkbox("checked: $data.Alarm")
    other.checked = false
    installKo(new Map([[other, { Alarm: () => true }]]))
    expect(checkboxTaken(other, false)).toBe(false)
  })

  it("reads a plain property as well as an observable", () => {
    const el = checkbox("checked: $data.Alarm")
    installKo(new Map([[el, { Alarm: true }]]))
    expect(checkboxTaken(el, true)).toBe(true)
  })

  it("falls back to the DOM when knockout is not reachable", () => {
    const el = checkbox("checked: $data.Alarm")
    el.checked = true
    expect(checkboxTaken(el, true)).toBe(true)
  })

  it("falls back to the DOM when the property is absent from their context", () => {
    const el = checkbox("checked: $data.Alarm")
    el.checked = true
    installKo(new Map([[el, { SomethingElse: () => false }]]))
    expect(checkboxTaken(el, true)).toBe(true)
  })

  it("falls back to the DOM when their observable throws", () => {
    const el = checkbox("checked: $data.Alarm")
    el.checked = false
    installKo(
      new Map([
        [
          el,
          {
            Alarm: () => {
              throw new Error("ko exploded")
            },
          },
        ],
      ]),
    )
    expect(checkboxTaken(el, false)).toBe(true)
  })
})

describe("write — checkbox", () => {
  it("ticks the box and fires click as well as change", () => {
    const el = checkbox("checked: $data.Alarm")
    const model = { value: false, Alarm: () => model.value }
    installKo(new Map([[el, model]]))
    const seen: string[] = []
    for (const type of ["click", "change"]) {
      el.addEventListener(type, () => {
        seen.push(type)
        model.value = el.checked
      })
    }
    expect(write(el, "yes", "alarm")).toBe(true)
    expect(el.checked).toBe(true)
    // click matters: their binding is `checked:`, which listens for it.
    expect(seen).toEqual(["click", "change"])
  })

  it("unticks for an empty value — that is the answer No, not a no-op", () => {
    const el = checkbox("checked: $data.Alarm")
    el.checked = true
    const model = { value: true, Alarm: () => model.value }
    installKo(new Map([[el, model]]))
    el.addEventListener("click", () => (model.value = el.checked))
    expect(write(el, "", "alarm")).toBe(true)
    expect(el.checked).toBe(false)
  })

  /* `checked` is settable on ANY input and reads back — so without the type
     check this branch reported success against a control that is not a
     checkbox at all. */
  it("refuses an input that is not a checkbox", () => {
    const el = document.createElement("input")
    el.type = "text"
    expect(write(el, "yes", "alarm")).toBe(false)
  })

  it("refuses a missing element", () => {
    expect(write(null, "yes", "alarm")).toBe(false)
  })
})

describe("write — number", () => {
  function numberInput() {
    const el = document.createElement("input")
    el.type = "number"
    document.body.appendChild(el)
    return el
  }

  it("writes an in-bounds amount", () => {
    const el = numberInput()
    expect(write(el, "350000", "contentsValue")).toBe(true)
    expect(el.value).toBe("350000")
  })

  /* The bound is checked BEFORE the assignment, so a refusal leaves their
     field holding what it held rather than half-written. FSP's own min/max are
     validation attributes that assignment never consults. */
  it.each(["99999", "7500001", "abc", ""])(
    "refuses %o without touching their field",
    (bad) => {
      const el = numberInput()
      el.value = "350000"
      expect(write(el, bad, "contentsValue")).toBe(false)
      expect(el.value).toBe("350000")
    },
  )

  it("applies the buildings bound, not the contents one", () => {
    const el = numberInput()
    // Above contents' 7 500 000 ceiling, below buildings' 10 000 000.
    expect(write(el, "9000000", "buildingValue")).toBe(true)
    expect(write(el, "9000000", "contentsValue")).toBe(false)
  })
})

describe("write — select", () => {
  function select(...values: string[]) {
    const el = document.createElement("select")
    for (const v of values) {
      const opt = document.createElement("option")
      opt.value = v
      el.appendChild(opt)
    }
    document.body.appendChild(el)
    return el
  }

  it("reports a value their option list does not contain", () => {
    const el = select("040", "600")
    expect(write(el, "999", "make")).toBe(false)
    expect(write(el, "040", "make")).toBe(true)
    expect(el.value).toBe("040")
  })

  it("fires input and change so their cascade runs", () => {
    const el = select("040")
    const seen: string[] = []
    for (const type of ["input", "change"]) el.addEventListener(type, () => seen.push(type))
    write(el, "040", "make")
    expect(seen).toEqual(["input", "change"])
  })
})

describe("control", () => {
  it("finds a field by name", () => {
    const el = document.createElement("input")
    el.setAttribute("name", FIELD_NAMES.contentsValue)
    document.body.appendChild(el)
    expect(control(document.body, "contentsValue")).toBe(el)
  })

  // FSP's multi-car checkbox carries an id and no name, so both are searched.
  it("falls back to an id", () => {
    const el = document.createElement("input")
    el.id = FIELD_NAMES.alarm
    document.body.appendChild(el)
    expect(control(document.body, "alarm")).toBe(el)
  })

  it("returns null when FSP no longer serve the control", () => {
    expect(control(document.body, "geyserCover")).toBeNull()
  })
})

describe("readOptions", () => {
  it("drops their empty placeholder option", () => {
    const el = document.createElement("select")
    for (const [value, text] of [
      ["", "Year"],
      ["2015", "2015"],
    ]) {
      const opt = document.createElement("option")
      opt.value = value
      opt.text = text
      el.appendChild(opt)
    }
    expect(readOptions(el)).toEqual([{ value: "2015", label: "2015" }])
  })

  it("returns nothing for a control that is not a select", () => {
    expect(readOptions(document.createElement("input"))).toEqual([])
    expect(readOptions(null)).toEqual([])
  })
})

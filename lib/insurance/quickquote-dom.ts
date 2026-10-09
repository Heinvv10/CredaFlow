/**
 * The DOM layer between our wizard and FSP's form.
 *
 * Split out of QuickQuoteWizard.tsx so it can be TESTED. Everything here
 * touches the document but nothing here touches React, so it runs under a
 * jsdom environment on its own — see quickquote-dom.test.ts, which declares
 * `@vitest-environment jsdom` per-file rather than flipping the suite default.
 *
 * That split was not tidiness. Two independent review rounds found defects in
 * this code and in no other part of the change; the parts that lived in the
 * pure bridge module were caught by tests or were right first time. These
 * functions decide whether an answer FSP actually took gets recorded — the
 * invariant the whole wizard rests on — and until now nothing could exercise
 * them at all.
 */
import { FIELD_KINDS, FIELD_NAMES, acceptsNumber, type QuickQuoteField } from "./quickquote-bridge"

export type Option = { value: string; label: string }

export function control(root: HTMLElement, field: QuickQuoteField): HTMLElement | null {
  const name = FIELD_NAMES[field]
  return root.querySelector<HTMLElement>(`[name="${name}"], #${name}`)
}

export function readOptions(el: HTMLElement | null): Option[] {
  if (!(el instanceof HTMLSelectElement)) return []
  return [...el.options]
    .filter((o) => o.value !== "")
    .map((o) => ({ value: o.value, label: o.text }))
}

/**
 * Whether FSP's own model now holds `want` for this checkbox.
 *
 * Their markup is `data-bind="checked: $data.Burglary"`, so the observable's
 * name is on the element and the object it lives on is what `ko.dataFor`
 * returns for that node — both MEASURED on quote-staging, where the three
 * boxes bind to `Burglary`, `Alarm` and `GeyserCover` on the HomeContent and
 * Buildings objects.
 *
 * Reading it back is what makes the checkbox branch of `write()` a real
 * accept-check rather than a re-read of our own assignment.
 *
 * Falls back to the DOM property when knockout is not reachable at all. That
 * is a genuinely weaker guarantee and is stated rather than hidden: it means
 * "the box is ticked", not "FSP recorded it". The fallback exists because the
 * alternative — refusing every tick whenever their bundle shifts — would
 * silently drop declarations instead, which is the worse failure. When the
 * model IS readable and disagrees, that is a real refusal and is reported.
 */
export function checkboxTaken(el: HTMLInputElement, want: boolean): boolean {
  const ko = (window as unknown as { ko?: { dataFor?: (n: Node) => unknown } }).ko
  if (typeof ko?.dataFor !== "function") return el.checked === want
  const property = checkedBindingProperty(el.getAttribute("data-bind"))
  if (!property) return el.checked === want
  try {
    const context = ko.dataFor(el) as Record<string, unknown> | null
    const held = context?.[property]
    if (held === undefined) return el.checked === want
    const current = typeof held === "function" ? (held as () => unknown)() : held
    // Interpret ONLY a boolean. Both alternatives are wrong in opposite
    // directions, and each has a failure that reaches a real application:
    //
    //   `current === want`     refuses a write FSP ACCEPTED whenever their
    //                          observable holds 1 or "Y", raising "We couldn't
    //                          record that answer" over a declaration that
    //                          landed, and clearing it.
    //   `Boolean(current)`     CONFIRMS a write FSP refused whenever it holds
    //                          "false", "N" or "0" — all truthy strings — so a
    //                          ticked "I have suffered a burglary" would be
    //                          recorded against a model still holding no.
    //
    // A value we cannot interpret is not evidence either way, so it degrades
    // to the DOM property below rather than being guessed at. Narrower than
    // both, and it cannot invent an answer in either direction.
    if (typeof current !== "boolean") return el.checked === want
    return current === want
  } catch {
    return el.checked === want
  }
}

/**
 * The observable name bound to `checked` at the TOP LEVEL of a data-bind.
 *
 * Anchored deliberately. An unanchored search took the first `checked:`
 * anywhere in the string, so `attr: { checked: isDefault }, checked: $data.Alarm`
 * resolved `isDefault` — and if that happened to be truthy, `checkboxTaken`
 * would confirm a write that `$data.Alarm` never received. Returning null on
 * anything unrecognised degrades to the DOM property, which is weaker but
 * honest; confirming the WRONG observable is not.
 *
 * Handles the shapes FSP actually ship (`checked: $data.Burglary`) plus the
 * near neighbours that would otherwise capture a binding-context name — the
 * old pattern read `$root` out of `checked: $root.policy().Alarm`, because
 * `$` is a valid identifier character.
 */
export function checkedBindingProperty(binding: string | null): string | null {
  if (!binding) return null
  // AMBIGUITY IS A REFUSAL. The comma split below counts delimiters and knows
  // nothing about string literals, so a quoted `)` or `}` inside a nested
  // object drops the depth to zero early and promotes that object's own
  // `checked:` to a top-level part — measured:
  //   attr: { title: 'a)', checked: isDefault }, checked: $data.Alarm
  // resolved `isDefault`, and a truthy `isDefault` would then confirm a write
  // `$data.Alarm` never received. Rather than write a full knockout parser for
  // one attribute, a second `checked:` anywhere means we cannot be sure which
  // one is ours, and null degrades to the DOM property. Only the wrong ANSWER
  // is dangerous; no answer is merely weaker.
  if ((binding.match(/\bchecked\s*:/g) ?? []).length !== 1) return null
  // Split on commas that are not inside braces/brackets/parens, so only
  // top-level binding keys are considered.
  let depth = 0
  const parts: string[] = []
  let current = ""
  for (const char of binding) {
    if ("{[(".includes(char)) depth++
    else if ("}])".includes(char)) depth--
    if (char === "," && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  parts.push(current)

  for (const part of parts) {
    const match = /^\s*checked\s*:\s*(?:\$data\.)?([A-Za-z_][\w$]*)\s*$/.exec(part)
    if (match) return match[1]
  }
  return null
}

/**
 * Writes a value into their control and lets their own handlers react.
 *
 * Returns whether their control ACCEPTED it — the invariant the whole wizard
 * rests on, so that we never record an answer FSP do not hold.
 *
 * HOW that is proven differs per control, which is why the field's declared
 * kind is a parameter rather than something sniffed off the element. A
 * checkbox and a number box are both `HTMLInputElement`, and their
 * accept-checks are nothing alike:
 *
 *  - select   — assigning a value that is not one of the options is silently
 *               discarded by the DOM and `el.value` becomes "". This is the
 *               original check and it is unchanged.
 *  - checkbox — `el.value` is "on" whatever the state is, so re-reading it
 *               proves nothing at all; `el.checked` is the answer. `click` is
 *               dispatched as well as `change` because their binding is
 *               `checked: $data.X` — measured on quote-staging, Burglary,
 *               Alarm and GeyserCover all flip on this pair.
 *  - number   — the DOM accepts ANY numeric string. FSP's `min`/`max` arrive
 *               as validation attributes that assignment never consults, so
 *               the bound is checked BEFORE the write and a refusal leaves
 *               their field untouched rather than half-written.
 */
export function write(
  el: HTMLElement | null,
  value: string,
  field: QuickQuoteField,
): boolean {
  const kind = FIELD_KINDS[field]

  if (kind.control === "checkbox") {
    // `checked` is settable on ANY input — a text box accepts it and reads it
    // back — so without this the branch would report success against a control
    // that is not a checkbox at all.
    if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") return false
    const want = value !== ""
    el.checked = want
    el.dispatchEvent(new Event("click", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    // Their MODEL, not the property we just assigned. `el.checked === want`
    // re-reads our own write and is true for any input element, so it proved
    // only that the node exists — while the docstring above claimed it proved
    // FSP accepted the value. For a risk declaration that gap is the whole
    // point: if their binding is renamed or fails to apply, we would record
    // "yes, I have suffered a burglary" against a model still holding false.
    return checkboxTaken(el, want)
  }

  if (!(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement)) return false

  // Before the assignment, deliberately: a rejected value must leave their
  // field holding whatever it held.
  if (kind.control === "number" && !acceptsNumber(field, value)) return false

  el.value = value
  // Their model is the authority, exactly as it is for the suburb. A select
  // that did not take the value reports "" here rather than throwing.
  if (el.value !== value) return false
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return true
}

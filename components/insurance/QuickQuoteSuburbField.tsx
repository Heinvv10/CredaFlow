"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Suburb entry, backed by FSP's own lookup.
 *
 * Their control is a jQuery UI autocomplete: typing calls
 * Policies/_LookupSuburb and renders suggestions into a `.ui-autocomplete`
 * list, and a suburb only counts once one of those suggestions is chosen —
 * writing the text alone leaves the quote unsubmittable.
 *
 * So this types into their input to trigger their lookup, reads their
 * suggestions back out, presents them as our own list, and clicks theirs on
 * selection. We never invent a suburb; every option shown came from FSP.
 */

type Props = {
  /** Their `SuburbMatch` input. */
  target: HTMLInputElement | null
  value: string
  onChange: (value: string) => void
  inputId: string
  /** A restore emptied this field, so say so rather than let it read as blank. */
  needsRepick?: boolean
}

const DEBOUNCE_MS = 250
const POLL_MS = 150
const POLL_WINDOW_MS = 6000

/**
 * FSP's authoritative suburb id, read off the knockout view model bound to
 * their SuburbMatch input. 0 means "no suburb selected".
 *
 * Their DOM carries no `Suburb` field — only the visible `SuburbMatch` text
 * box — so the id lives on the view model, as a PLAIN number rather than an
 * observable (knockout 2.2.1; verified live). Anything at all can be written
 * into SuburbMatch without FSP accepting a suburb, so the text box says
 * nothing about whether a quote is submittable and must never be used as
 * proof of one. Both shapes are unwrapped in case they upgrade knockout.
 *
 * Unreadable counts as 0 — fail closed. Do NOT justify that with
 * missingFields(): it inspects only the name/id attributes of the form FSP
 * served, so it can say nothing about whether window.ko, ko.dataFor, or the
 * view model carrying Suburb still exist. FSP renaming Suburb or moving off
 * the global passes that check, keeps takeover, and lands here — which is why
 * this must fail closed on its own account rather than on a guarantee
 * something else was supposed to have made. The visible consequence is a
 * suburb that cannot be confirmed; the alternative is confirming one their
 * model never recorded, which is the failure this exists to prevent.
 */
function suburbId(target: HTMLInputElement | null): number {
  if (!target) return 0
  const ko = (window as unknown as { ko?: { dataFor?: (node: Node) => unknown } }).ko
  if (typeof ko?.dataFor !== "function") return 0
  try {
    const vm = ko.dataFor(target) as { Suburb?: unknown } | null
    const raw = typeof vm?.Suburb === "function" ? (vm.Suburb as () => unknown)() : vm?.Suburb
    const id = Number(raw)
    return Number.isFinite(id) ? id : 0
  } catch {
    return 0
  }
}

export function QuickQuoteSuburbField({
  target,
  value,
  onChange,
  inputId,
  needsRepick = false,
}: Props) {
  const [query, setQuery] = useState(value)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [searching, setSearching] = useState(false)
  /* A non-empty string is not a selection — only FSP's model is. Seeding this
     from `value !== ""` meant an answer replayed across a "Change answers"
     reload, which writes the label straight into SuburbMatch and never runs
     their select handler, drew a confirmed tick over a form holding
     Suburb = 0. The quote then came back empty and the visitor was told the
     insurers were not responding. Every other route to `true` runs through
     choose(), which verifies their model first.
     NOTE: this stops the wizard CONFIRMING a suburb it does not have; it does
     not yet re-select one on restore, so a restored journey still needs the
     suburb picked again. That fix is still open. */
  const [chosen, setChosen] = useState(() => suburbId(target) !== 0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [failure, setFailure] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const timer = useRef<number | null>(null)
  const alive = useRef(true)
  const listRef = useRef<HTMLUListElement | null>(null)
  const everResponded = useRef(false)

  /* On a phone the list opens below the keyboard, so the visitor types and
     nothing appears to happen. Bring it into view when it opens. */
  useEffect(() => {
    if (suggestions.length === 0) return
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    listRef.current?.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    })
  }, [suggestions.length])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  function search(next: string) {
    setQuery(next)
    setChosen(false)
    setFailure(null)
    setTimedOut(false)
    onChange("")
    if (timer.current) window.clearTimeout(timer.current)
    if (!target || next.trim().length < 2) {
      setSuggestions([])
      setSearching(false)
      return
    }

    setSearching(true)
    timer.current = window.setTimeout(() => {
      // Trigger their lookup WITHOUT touching focus. An earlier version called
      // target.focus() so jQuery UI's key handlers would fire; that moved real
      // focus to their off-screen input permanently, so the visible field went
      // stale mid-word and no key ever reached our handlers again — the wizard
      // could not be completed by keyboard at all. jQuery UI's documented
      // `autocomplete("search", term)` does the same job without stealing it.
      target.value = next
      const jq = (window as unknown as { jQuery?: (el: Element) => { autocomplete?: (m: string, t?: string) => void } }).jQuery
      const widget = jq?.(target)
      if (widget?.autocomplete) {
        widget.autocomplete("search", next)
      } else {
        // No jQuery UI: fall back to events, still without focus().
        target.dispatchEvent(new Event("input", { bubbles: true }))
        target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }))
      }

      const deadline = Date.now() + POLL_WINDOW_MS
      const term = next.trim().toLowerCase()
      // Tracks whether their list ever populated at all. Without this a typo
      // produced no matches, fell through to the timeout, and told the visitor
      // their connection was down — blaming the network for a spelling slip at
      // the first point of friction in the journey.
      let anyResponse = false
      const poll = () => {
        if (!alive.current) return
        const raw = [...document.querySelectorAll(".ui-autocomplete li")]
          .map((li) => (li.textContent ?? "").trim())
          .filter(Boolean)
        if (raw.length > 0) {
          anyResponse = true
          everResponded.current = true
        }
        const items = [...document.querySelectorAll(".ui-autocomplete li")]
          .map((li) => (li.textContent ?? "").trim())
          .filter(Boolean)
          // Their list still holds the PREVIOUS query's results until the new
          // lookup returns, so an unfiltered poll returns immediately with
          // stale data — typing "Sandton" offered "SAN DIEGO", and picking the
          // first suggestion by keyboard chose the wrong suburb entirely.
          // Only accept suggestions that actually match what was typed.
          .filter((label) => label.toLowerCase().includes(term))
        if (items.length > 0) {
          setSuggestions(items.slice(0, 8))
          setSearching(false)
          return
        }
        if (Date.now() > deadline) {
          setSuggestions([])
          setSearching(false)
          // An empty list is indistinguishable from an unanswered one: jQuery
          // UI leaves .ui-autocomplete empty in both cases. A typo is far more
          // likely than an outage, and telling someone their connection is
          // down for a misspelling sends them to check their wifi at the first
          // point of friction in the journey. So "no match" is the default and
          // the connection wording needs positive evidence — the lookup having
          // worked earlier in this session and then stopping.
          setTimedOut(everResponded.current && !anyResponse)
          return
        }
        window.setTimeout(poll, POLL_MS)
      }
      poll()
    }, DEBOUNCE_MS)
  }

  function choose(label: string) {
    // Click THEIR suggestion so their own handler records the selection —
    // setting the text would leave their model empty and the quote invalid.
    const match = [...document.querySelectorAll<HTMLElement>(".ui-autocomplete li")].find(
      (li) => (li.textContent ?? "").trim() === label,
    )
    const clickable = match?.querySelector<HTMLElement>("a") ?? match

    // If their list has moved on, `clickable?.click()` is a silent no-op and
    // an earlier version still set chosen=true — turning "their handler never
    // ran" into a green tick, while the quote stayed unsubmittable. Never
    // confirm what was not verified.
    if (!clickable) {
      setFailure("That suburb is no longer in the list — please search again.")
      setSuggestions([])
      setChosen(false)
      setActiveIndex(-1)
      onChange("")
      return
    }

    clickable.click()

    // Their model is the authority: confirm it actually took the selection.
    // Reading target.value here only proved the TEXT box had been filled —
    // which their handler and a plain restore write do alike, so it passed
    // while Suburb stayed 0 and the quote was unsubmittable.
    if (suburbId(target) === 0) {
      setFailure("We couldn't record that suburb — please pick it again.")
      setChosen(false)
      onChange("")
      return
    }

    setFailure(null)
    setQuery(label)
    setSuggestions([])
    setChosen(true)
    setActiveIndex(-1)
    onChange(label)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((i) => (i + 1) % suggestions.length)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault()
      choose(suggestions[activeIndex]!)
    } else if (event.key === "Escape") {
      setSuggestions([])
      setActiveIndex(-1)
    }
  }

  return (
    <div className="cf-suburb">
      <input
        id={inputId}
        type="text"
        autoComplete="off"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={`${inputId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${inputId}-opt-${activeIndex}` : undefined}
        aria-required="true"
        aria-describedby={needsRepick && !chosen ? `${inputId}-repick` : undefined}
        placeholder="Start typing your suburb or postal code"
        value={query}
        onChange={(e) => search(e.target.value)}
        onKeyDown={onKeyDown}
      />

      {/* An edit cannot carry the suburb across, because FSP only records one
          when their own select handler runs. The field is therefore emptied on
          the visitor's behalf — and without saying so, a sighted visitor has to
          infer it from one blank box between two filled ones, while a keyboard
          or screen-reader user gets nothing at all: Continue is `disabled` so it
          leaves the tab order entirely, and they tab straight past to Back and
          out of the wizard, never told a forward control exists. Say it plainly
          instead, and describe the input so it is announced on focus. */}
      {needsRepick && !chosen && (
        <p className="cf-suburb-repick" id={`${inputId}-repick`}>
          Please pick your suburb again — we couldn&apos;t carry it over.
        </p>
      )}

      <p className="cf-suburb-status" role="status" aria-live="polite">
        {searching ? "Looking up suburbs…" : ""}
      </p>

      {suggestions.length > 0 && (
        <ul className="cf-suburb-list" id={`${inputId}-list`} role="listbox" ref={listRef}>
          {/* Options carry virtual focus only — a nested <button> would be an
              extra tab stop and break the single-tab-stop combobox model. */}
          {suggestions.map((s, i) => (
            <li
              key={s}
              id={`${inputId}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? "is-active" : undefined}
              // pointermove, filtered to a real mouse: on a touchscreen a
              // scroll passing over an option fired mouseenter and left a
              // phantom highlight, right next to the tap that commits.
              onPointerMove={(e) => {
                if (e.pointerType === "mouse") setActiveIndex(i)
              }}
              onMouseDown={(e) => {
                // mousedown, not click: the input must not blur first.
                e.preventDefault()
                choose(s)
              }}
            >
              {s}
            </li>
          ))}
        </ul>
      )}

      {/* Their model only has a suburb once a suggestion is picked, so say so
          rather than letting someone type freely and fail at submit. */}
      <p className="cf-suburb-status" role="status" aria-live="polite">
        {failure
          ? failure
          : timedOut
            ? "Suburb search isn't responding — check your connection and try again."
            : !chosen && query.trim().length >= 2 && !searching && suggestions.length === 0
              ? `No suburb matches "${query.trim()}". Check the spelling, or try your postal code.`
              : ""}
      </p>
      <p className="cf-suburb-ok" role="status" aria-live="polite">
        {chosen ? `\u2713 ${query}` : ""}
      </p>
    </div>
  )
}

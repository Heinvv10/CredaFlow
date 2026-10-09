"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { QUOTE_FRAME_DIRTY_MESSAGE } from "@/lib/insurance/quickquote-frame-message"
import type { QuickQuoteView } from "@/lib/insurance/quickquote-config"
import { QuickQuoteBootSkeleton } from "@/components/insurance/QuickQuoteBootSkeleton"
import {
  control,
  readOptions,
  write,
  type Option,
} from "@/lib/insurance/quickquote-dom"
import { QuickQuoteSuburbField } from "@/components/insurance/QuickQuoteSuburbField"
import {
  QuickQuoteResults,
  extractQuotes,
  sameArrival,
} from "@/components/insurance/QuickQuoteResults"
import { QuickQuoteWaiting } from "@/components/insurance/QuickQuoteWaiting"
import {
  FIELD_NAMES,
  MAX_VEHICLES,
  POLICY_FIELDS,
  WIZARD_STEPS_BY_VIEW,
  FIELD_KINDS,
  acceptsNumber,
  askedFields,
  CHECK_AFFIRMATIVES,
  summaryValue,
  formatRands,
  isUnanswered,
  VEHICLE_FIELDS,
  LABELS,
  WIZARD_STEPS,
  buildSteps,
  canAddVehicle,
  detailsFromSaIdNumber,
  furthestReachableStep,
  missingFields,
  settleDelay,
  shouldHoldForResort,
  type ParsedQuote,
  type QuickQuoteField,
  type SavedVehicle,
} from "@/lib/insurance/quickquote-bridge"

/**
 * Our stepped journey, driving FSP's form underneath.
 *
 * FSP render one long form with twelve controls. This presents the same
 * questions as four short steps with our own controls, writing each answer
 * into their hidden form and reading their cascading lookups (make, model,
 * suburb) back out. Their form stays authoritative — we never invent an
 * option they did not offer.
 *
 * FALLBACK IS THE POINT. Their markup changes without notice, so if any field
 * we depend on is absent, `takeover` is abandoned and their own form is
 * revealed untouched. A visitor must never be trapped behind a wizard that
 * cannot submit.
 */

/**
 * Quiet period before results are handed over.
 *
 * Measured arrivals spread over 5.1s on a real panel (4 rows at 8.7s, the 5th
 * at 13.8s). At 1800ms we revealed 3.3s early and asserted the wrong best
 * price — R1059.90 badged while King Price at R982.60 was still in flight.
 * A superlative about a financial product has to wait for the field to stop
 * moving.
 */
const SETTLE_MS = 4500

/**
 * Debounce once FSP have SAID the panel is finished.
 *
 * Their model flips before the last row is necessarily painted, so this is a
 * beat for the DOM to catch up rather than a guess about the network. Any row
 * still arriving re-arms it, so a late arrival cannot be revealed past.
 */
const PAINT_MS = 400

/* How long the results screen waits so the arrival's re-sort can finish.
   The transition is 900ms (--cf-arrival-row in quickquote-theme.css); the
   extra 250ms is a beat to actually read the reordered list before it is
   replaced. Only ever spent when there is a re-sort to watch — see
   shouldHoldForResort. */
const RESORT_HOLD_MS = 1150

/**
 * Bound for "rows in hand, but their signal has not fired".
 *
 * Waiting on allquotesdone is right while it is still plausibly coming, and
 * wrong forever. This case previously inherited the 45s failAt bound, which
 * was chosen to answer a different question — "have the insurers failed?" —
 * and left someone watching a progress bar for three quarters of a minute
 * with their quotes already fetched.
 *
 * Measured arrival spreads are ~5s (4 rows at 8.7s, the 5th at 13.8s; 4 at
 * 11.9s, the 5th at 17.1s). Twelve seconds of no new row AND no signal is
 * well past any spread observed, so it means their signal is not coming
 * rather than that the panel is still working. Re-armed by each arrival, so
 * it is silence since the LAST row, not since the first.
 */
const SIGNAL_SILENT_MS = 12000

type KoObservable = {
  (): unknown
  subscribe(cb: (value: unknown) => void): { dispose(): void }
}

/**
 * FSP's own "the panel has finished" signal.
 *
 * Their root view model carries `allquotesdone` as a real knockout observable
 * — verified live: ko.isObservable true, .subscribe present, false during a
 * run. Waiting on it beats waiting out SETTLE_MS, which knows nothing about
 * the request and simply spends 4.5s on every successful quote.
 *
 * Returns null when it cannot be read, and the caller then keeps the timer.
 * A missing signal must never be mistaken for a finished panel: revealing
 * early is what once badged R1059.90 as the best price while King Price at
 * R982.60 was still in flight.
 */
function allQuotesDone(root: HTMLElement | null): KoObservable | null {
  if (!root) return null
  const ko = (window as unknown as { ko?: { dataFor?: (node: Node) => unknown } }).ko
  if (typeof ko?.dataFor !== "function") return null
  try {
    const vm = ko.dataFor(root) as { allquotesdone?: unknown } | null
    const obs = vm?.allquotesdone
    if (typeof obs !== "function") return null
    if (typeof (obs as KoObservable).subscribe !== "function") return null
    return obs as KoObservable
  } catch {
    return null
  }
}

/**
 * How many vehicles FSP's model currently holds.
 *
 * Their model is the authority on whether a car was actually added: their
 * `saveVehicle` refuses silently, so a click is not evidence and only the
 * count is. Returns null when it cannot be read, and the caller then leaves
 * the journey exactly as it was.
 */
function vehicleCountFrom(root: HTMLElement | null): number | null {
  if (!root) return null
  const ko = (window as unknown as { ko?: { dataFor?: (node: Node) => unknown } }).ko
  if (typeof ko?.dataFor !== "function") return null
  try {
    const form = root.querySelector("form#quotationDetails")
    if (!form) return null
    const vm = ko.dataFor(form) as { policy?: () => { Vehicles?: unknown[] } } | null
    const vehicles = vm?.policy?.().Vehicles
    return Array.isArray(vehicles) ? vehicles.length : null
  } catch {
    return null
  }
}

/**
 * Calls FSP's own addVehicle — their raw push, not their click path. The
 * checkbox's own handler is `saveVehicle`, which validates
 * ADD_VEHICLE_GATE_FIELDS and only calls `addVehicle` once that passes;
 * driving already-validated, already-written data back through their
 * validator a second time is a dependency the replay does not need.
 *
 * Returns whether a vehicle actually landed, not whether the call merely
 * avoided throwing: `vehicleCountFrom` is read before and after, and only a
 * clean +1 counts as success. "A click proves nothing and the count proves
 * everything" holds for this call too — if FSP ever route `addVehicle`
 * itself through a validating wrapper, a call that silently no-ops must not
 * be reported as a landed car.
 */
function addVehicleOnHost(root: HTMLElement | null): boolean {
  if (!root) return false
  const ko = (window as unknown as { ko?: { dataFor?: (node: Node) => unknown } }).ko
  if (typeof ko?.dataFor !== "function") return false
  try {
    const form = root.querySelector("form#quotationDetails")
    if (!form) return false
    const vm = ko.dataFor(form) as { addVehicle?: () => void } | null
    if (typeof vm?.addVehicle !== "function") return false
    const before = vehicleCountFrom(root)
    vm.addVehicle()
    const after = vehicleCountFrom(root)
    return before !== null && after === before + 1
  } catch {
    return false
  }
}

/**
 * Tears the currently active vehicle back out of FSP's model — the inverse
 * of an add. Never throws, and changes nothing when their model cannot be
 * reached.
 *
 * MEASURED on quote-staging, 2026-08-08, immediately after calling this on a
 * two-vehicle policy: `Vehicles.length` drops by one, the remaining (now
 * active) vehicle's Year is repopulated from FSP's own memory ("2018"), and
 * the per-policy licence fields — absent from the DOM since the add — are
 * back. A full inverse of `addVehicle()`, not a partial one.
 *
 * Returns whether a vehicle actually LEFT, not whether the call merely
 * avoided throwing — the same standard `addVehicleOnHost` holds itself to,
 * and for the same reason: "a click proves nothing and the count proves
 * everything" is a statement about their model, so it applies identically to
 * the inverse. The caller decrements our own count and drops a saved snapshot
 * on the strength of this answer, so a call that ran but removed nothing must
 * not report success — that would leave us claiming one car while FSP still
 * hold two, which is the our-model-vs-theirs divergence this branch has
 * already shipped one Critical over.
 */
function removeActiveVehicleFrom(root: HTMLElement | null): boolean {
  if (!root) return false
  const ko = (window as unknown as { ko?: { dataFor?: (node: Node) => unknown } }).ko
  if (typeof ko?.dataFor !== "function") return false
  try {
    const form = root.querySelector("form#quotationDetails")
    if (!form) return false
    const vm = ko.dataFor(form) as { removeActiveVehicle?: () => void } | null
    if (typeof vm?.removeActiveVehicle !== "function") return false
    const before = vehicleCountFrom(root)
    vm.removeActiveVehicle()
    const after = vehicleCountFrom(root)
    return before !== null && after === before - 1
  } catch {
    return false
  }
}


/**
 * Hints shown under a field.
 *
 * `lastClaim` is the important one: FSP's options run from "Less than 1 year"
 * to "More than 7 years" and then "I haven't had insurance in the past 8
 * years" — there is no "I have never claimed". A claims-free driver with a
 * decade of cover has no truthful answer, and the nearest option asserts they
 * were uninsured, which is a materially worse risk statement and mis-prices
 * them. We cannot add to their list, so we tell people how to answer. Raised
 * with FSP separately.
 */
/**
 * A number field's bounds, narrowed.
 *
 * FIELD_KINDS is a discriminated union and the render path has already tested
 * the discriminant, but TypeScript cannot carry that through the JSX ternary —
 * so this re-narrows in one place rather than casting at each of the five
 * usages.
 */
function numberKind(field: QuickQuoteField): { min: number; max: number; step: number } {
  const kind = FIELD_KINDS[field]
  if (kind.control !== "number") throw new Error(`${field} is not a number field`)
  return kind
}

const HINTS: Partial<Record<QuickQuoteField, string>> = {
  lastClaim: "Never claimed? Choose the longest period you've been insured for.",
  licenceType: "Code B is the standard car licence — previously called Code 08.",
}

/**
 * Field order for the MULTI-CAR results summary, used only once there are
 * two or more cars (see the branch in the results summary below). Derived
 * from WIZARD_STEPS rather than hand-written: POLICY_FIELDS/VEHICLE_FIELDS
 * list which fields belong to which group but not the order the visitor was
 * actually asked them in, and writing that order out again here would be a
 * fourth and fifth field list to keep in sync with the three that already
 * exist.
 */
const STEP_FIELD_ORDER = WIZARD_STEPS.flatMap((st) => st.fields)
const POLICY_FIELD_STEP_ORDER = STEP_FIELD_ORDER.filter((f) => POLICY_FIELDS.includes(f))
const VEHICLE_FIELD_STEP_ORDER = STEP_FIELD_ORDER.filter((f) => VEHICLE_FIELDS.includes(f))

export function QuickQuoteWizard({
  hostId = "fspqq",
  multiVehicle = false,
  view = "motor",
}: { hostId?: string; multiVehicle?: boolean; view?: QuickQuoteView }) {
  const [ready, setReady] = useState(false)
  const [takeover, setTakeover] = useState(false)
  /** Their widget never rendered a form at all — see the boot poll below. */
  const [bootFailed, setBootFailed] = useState(false)
  /** A restore dropped the suburb, so the field must ask for it back. */
  const [suburbDropped, setSuburbDropped] = useState(false)
  /** They tried to move on before the step was answered. Explains, once asked. */
  const [blocked, setBlocked] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)
  const [answers, setAnswers] = useState<Partial<Record<QuickQuoteField, string>>>({})
  const [options, setOptions] = useState<Partial<Record<QuickQuoteField, Option[]>>>({})
  /* What is literally in each number box. Distinct from `answers`, which only
     ever holds what FSP accepted — see setNumber for why they must differ. */
  const [drafts, setDrafts] = useState<Partial<Record<QuickQuoteField, string>>>({})
  /* Fields whose last write FSP refused, for the two control kinds where that
     would otherwise be invisible: a checkbox never gates Continue, and a
     number keeps its draft in the box so the field still looks filled. */
  const [writeFailed, setWriteFailed] = useState<QuickQuoteField[]>([])
  const [idNumber, setIdNumber] = useState("")
  const [idNote, setIdNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<QuickQuoteField | null>(null)
  const alive = useRef(true)
  const [submitted, setSubmitted] = useState(false)
  const [quoteCount, setQuoteCount] = useState(0)
  /* Quotes as they land, for the arrival list on the wait screen. Parsed with
     extractQuotes — the SAME parse the results screen uses — so the two
     surfaces cannot disagree mid-journey. quoteCount stays separate: it counts
     usable rows and feeds waitingStage's evidence floor. */
  const [arrived, setArrived] = useState<ParsedQuote[]>([])
  const [settled, setSettled] = useState(false)
  const [resortPlayed, setResortPlayed] = useState(false)
  /** FSP have confirmed the panel is finished — gates the superlatives only. */
  const [panelComplete, setPanelComplete] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)
  const [timedOut, setTimedOut] = useState(false)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const moreCarsRef = useRef<HTMLDivElement | null>(null)
  /* How many cars FSP's model holds. Caps the journey at MAX_VEHICLES and
     decides whether the results summary is a multi-car one. NOT the number of
     car steps we owe — see appendedCarSteps. */
  const [vehicleCount, setVehicleCount] = useState(1)
  /* How many appended car steps the visitor is still owed.
     Distinct from vehicleCount, and the distinction only appears on the
     restore path: an add increments both, a back-out decrements both, and a
     restore leaves this at 0 while vehicleCount becomes the number of cars
     that landed. The reason is FSP's, not ours — their vehicle fields are flat
     and un-indexed and bind to the ACTIVE vehicle, so a restored earlier car
     is not editable at all. Appending a step for one produced a screen that
     asked about car 1 and wrote into car 3. See buildSteps. */
  const [appendedCarSteps, setAppendedCarSteps] = useState(0)
  /* Answers for cars already saved into FSP's model, kept for the summary and
     the replay. Their form clears on add, so this is the only record we hold. */
  const [savedVehicles, setSavedVehicles] = useState<SavedVehicle[]>([])
  /* How many cars a "Change answers" replay could not put back — 0 on every
     path except a multi-car restore where an addVehicleOnHost call failed
     partway through, or a flag-off build meeting a payload a flag-on build
     wrote. See the restore effect below. */
  const [carsNotRestored, setCarsNotRestored] = useState(0)
  /* Whether FSP's vehicle count is READABLE — the precondition for offering
     their add-a-car control at all. Held in state and refreshed by an effect
     because it is a knockout/DOM read, and render must be pure. */
  const [countReadable, setCountReadable] = useState(false)
  /* Latched once their control has actually been offered. Arms the
     add-detection poll — see that effect for why it must not arm on a value
     that can flip back. */
  const [moreCarsOffered, setMoreCarsOffered] = useState(false)
  const steps = useMemo(
    () =>
      // Cars are motor's concern alone. Home and buildings have no per-risk
      // repeat, so their step list is fixed and buildSteps never runs on them
      // — which also keeps buildSteps returning WIZARD_STEPS' own identity for
      // a one-car motor journey, the flag-off regression floor.
      view === "motor"
        ? buildSteps(vehicleCount, appendedCarSteps)
        : WIZARD_STEPS_BY_VIEW[view],
    [view, vehicleCount, appendedCarSteps],
  )

  const host = useCallback(
    () => (typeof document === "undefined" ? null : document.getElementById(hostId)),
    [hostId],
  )

  /* Wait for FSP's form, then decide whether we can present our own. */
  useEffect(() => {
    let cancelled = false
    const started = Date.now()
    const tick = () => {
      if (cancelled) return
      const root = host()
      const form = root?.querySelector<HTMLFormElement>("form#quotationDetails")
      // Their form element appears BEFORE knockout populates the selects it
      // contains. Reading options at first sight of the form left every
      // dropdown permanently empty on any load where that race went the other
      // way — reliably on a warm reload, which is exactly the "Change answers"
      // path. Wait for real options, not just the form.
      const ready =
        form && (form.querySelector<HTMLSelectElement>(`[name="${FIELD_NAMES.birthYear}"]`)?.options.length ?? 0) > 1
      if (form && ready) {
        const present = [...form.querySelectorAll<HTMLElement>("[name], [id]")].map(
          (el) => el.getAttribute("name") || el.id,
        )
        const gaps = missingFields(present.filter(Boolean) as string[], view)
        setReady(true)
        // Any missing field means our journey cannot complete — hand back.
        setTakeover(gaps.length === 0)
        if (gaps.length === 0) {
          root!.setAttribute("data-cf-takeover", "true")
          // Off-screen is not hidden. Their form keeps 21 focusable controls in
          // the tab order and the accessibility tree, so a keyboard user tabbing
          // past our last field lands in a dozen invisible inputs with no signal
          // anything happened. `inert` removes it from both.
          form.setAttribute("inert", "")
          form.setAttribute("aria-hidden", "true")
          // Derived from the view's own step list rather than written out.
          // The literal this replaces named motor's nine selects, so a home
          // journey would have rendered `movedInYear` — a 101-option select —
          // permanently empty, and any field added to a step had to be
          // remembered here too or it silently arrived with no options.
          setOptions(
            Object.fromEntries(
              askedFields(view)
                .filter((f) => FIELD_KINDS[f].control === "select")
                .map((f) => [f, readOptions(control(root!, f))]),
            ),
          )
          // Adopt whatever FSP's checkboxes already hold, rather than assuming
          // they all arrive unticked. `geyserCover` elects an optional cover,
          // and an upsell arriving pre-checked is entirely ordinary — we would
          // then have shown "not elected", said so in the summary, and had the
          // quote priced WITH the cover. Our box now starts where theirs is.
          const preset = askedFields(view).filter(
            (f) =>
              FIELD_KINDS[f].control === "checkbox" &&
              (control(root!, f) as HTMLInputElement | null)?.checked,
          )
          if (preset.length > 0) {
            setAnswers((a) => ({
              ...a,
              ...Object.fromEntries(preset.map((f) => [f, "yes"])),
            }))
          }
        }
        return
      }
      // Their script loads asynchronously; give it a bounded window.
      if (Date.now() - started > 20000) {
        setReady(true)
        setTakeover(false)
        // "Degrade to their UI, never to a blank screen" only holds when their
        // markup CHANGED — their form is then present and the stylesheet
        // reveals it. It does not hold when their widget HANGS: #fspqq can sit
        // on <div class="initLoading">Loading...</div> forever with no form at
        // all, so missingFields() never runs, takeover goes false, and we
        // render null into a region nothing will ever fill. Observed once in
        // roughly twenty loads. Their form still being absent here is what
        // separates the two, so own the failure rather than leave an empty page.
        setBootFailed(!form)
        return
      }
      window.setTimeout(tick, 250)
    }
    tick()
    return () => {
      cancelled = true
    }
    // `view` decides which fields this effect requires and reads, so it is
    // listed. It does not change in practice — QuickQuotePanel re-points the
    // iframe src, which reloads the document — but the steps memo already
    // treats it as a dependency, and a file that calls it mutable in one place
    // and immutable in another is one refactor away from a takeover computed
    // for a view the visitor is no longer on.
  }, [host, view])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /* Move focus to the new step heading so keyboard and screen-reader users
     are not left at the bottom of the previous step.
     focusNonce is in the deps because returning from results lands on the step
     we were already on — setStepIndex to its current value is a no-op React
     bails on, so this effect never re-fired and focus was abandoned to <body>
     on that one path. */
  const mounted = useRef(false)
  useEffect(() => {
    // Not on first paint: the widget appears ~3s after page load, and focusing
    // then yanked a visitor who had already scrolled back to the top.
    //
    // The guard has to be armed on the first render that COULD focus, not the
    // first render that runs. Boot returns early with headingRef null, so
    // spending it there left it already used when takeover flipped — and the
    // wizard's real first paint then grabbed focus and threw an untouched
    // visitor ~2000px down the page, exactly what the line above forbids.
    if (!takeover) return
    if (!mounted.current) {
      mounted.current = true
      return
    }
    headingRef.current?.focus()
  }, [stepIndex, takeover, focusNonce])

  const set = useCallback(
    async (field: QuickQuoteField, value: string) => {
      const root = host()
      if (!root) return
      // Record what THEIR form took, not what we asked it to take. This used
      // to write the answer first and never look: a value absent from their
      // options is silently discarded, so `answers.make` could hold a make
      // their form did not, stepComplete passed, and the quote submitted with
      // no vehicle in it. That is the suburb defect in general form — the
      // suburb was bound to their model and the nine selects were not.
      const took = write(control(root, field), value, field)
      setAnswers((a) => ({ ...a, [field]: took ? value : "" }))
      const kind = FIELD_KINDS[field].control
      if (kind === "checkbox" || kind === "number") {
        setWriteFailed((f) =>
          took ? f.filter((x) => x !== field) : f.includes(field) ? f : [...f, field],
        )
      }
      // Their control did not take it, so their model still holds whatever it
      // held and no change event fired. Running the cascade anyway left the
      // dependent select showing "Loading…" with no options for a full 15s,
      // polling for a change that nothing will ever trigger.
      if (!took) {
        setBusy(null)
        return
      }

      // Make and model are populated by FSP's own AJAX once the field above is
      // set, so we wait for their options to arrive and adopt them.
      const dependents: Partial<Record<QuickQuoteField, QuickQuoteField>> = {
        vehicleYear: "make",
        make: "model",
      }
      const next = dependents[field]
      if (!next) return

      setBusy(next)
      // Clear everything DOWNSTREAM of the field just set — both answers and
      // options, and never the field itself. Clearing answers alone left the
      // previous year's makes on offer and the poll accepted them, because
      // "some options exist" was its success test; a visitor could then pick a
      // make FSP has no record of, which wrote an empty value into their form
      // and produced a quote request with no vehicle at all.
      //
      // The field itself must be excluded: an earlier version cleared `make`
      // whenever the model cascade fired, which is exactly when a make has
      // just been chosen — so it wiped the selection that triggered it and the
      // step could never complete.
      const downstream: QuickQuoteField[] = next === "make" ? ["make", "model"] : ["model"]
      setAnswers((a) => {
        const cleared = { ...a }
        for (const f of downstream) delete cleared[f]
        return cleared
      })
      setOptions((o) => {
        const cleared = { ...o }
        for (const f of downstream) cleared[f] = []
        return cleared
      })

      // Their select still holds the old list at this instant, so remember it
      // and wait for it to actually CHANGE rather than merely be non-empty.
      const previous = readOptions(control(root, next))
        .map((o) => o.value)
        .join("|")
      // Resolve only once their new list has landed. `set` is awaited by the
      // restore replay, and returning as soon as the poll STARTED meant the
      // next field was written into a select that did not yet contain it — so
      // make and model came back empty on every "Change answers" round trip,
      // leaving FSP's form with no vehicle.
      const deadline = Date.now() + 15000
      await new Promise<void>((resolve) => {
        const poll = () => {
          if (!alive.current) {
            resolve()
            return
          }
          const opts = readOptions(control(root, next))
          const signature = opts.map((o) => o.value).join("|")
          if (opts.length > 0 && signature !== previous) {
            setOptions((o) => ({ ...o, [next]: opts }))
            setBusy(null)
            resolve()
            return
          }
          if (Date.now() > deadline) {
            setBusy(null)
            resolve()
            return
          }
          window.setTimeout(poll, 200)
        }
        poll()
      })
    },
    [host],
  )

  /**
   * A number field's keystroke.
   *
   * Numbers are the one control where what the visitor is TYPING and what FSP
   * have ACCEPTED are legitimately different for a while, so they are held
   * separately:
   *
   *   drafts[field]  — exactly what is in the box, always
   *   answers[field] — only ever a value FSP's model took
   *
   * Binding the box to `answers` instead made both new journeys impossible to
   * complete by typing. Every prefix of a valid amount is below FSP's minimum
   * — "3", "35", "350", "3500", "35000" are all under R100 000 — so `set()`
   * refused each keystroke, wrote "" into `answers`, and React restored the
   * controlled input to empty. The digit vanished as it was typed, backspacing
   * one character wiped the whole field, and on mobile (no spinner) there was
   * no way to fill it at all.
   *
   * The invariant is untouched: an out-of-range draft clears the recorded
   * answer, so the step stays incomplete and Continue stays disabled. It just
   * stops the box fighting the person filling it in.
   */
  const setNumber = useCallback(
    async (field: QuickQuoteField, raw: string) => {
      setDrafts((d) => ({ ...d, [field]: raw }))
      if (acceptsNumber(field, raw)) {
        await set(field, raw)
        return
      }
      // Not something FSP can quote, so nothing is recorded and their field is
      // left holding whatever it held. write() is never called.
      setAnswers((a) => ({ ...a, [field]: "" }))
    },
    [set],
  )

  /**
   * A typed amount that is not currently recorded against FSP's form.
   *
   * TWO causes, and the field has to show both. Out of their range is the
   * obvious one. The other is a write they refused for any other reason — the
   * control moved, or something matched the name that is not their input — and
   * that one is the more misleading of the two, because the draft keeps the
   * amount in the box: without this the visitor saw a filled field, a neutral
   * hint, and a Continue button that would not enable, with nothing connecting
   * them.
   */
  const numberRejected = useCallback(
    (field: QuickQuoteField) => {
      const draft = drafts[field] ?? ""
      if (draft === "") return false
      return !acceptsNumber(field, draft) || writeFailed.includes(field)
    },
    [drafts, writeFailed],
  )

  /* Declared here, ahead of the restore effect below, rather than beside the
     "appended car step" effect further down that owns it — a successful
     multi-car restore calls setVehicleCount(landed) with landed > 1, and
     without resyncing this ref first, that effect reads the jump from its
     initial 1 as a fresh ADD and shoves the visitor onto the last (car-N)
     step, skipping the "where" step's suburb re-pick gate entirely. See
     `lastAdded.current = landed` in the restore effect below. */
  const lastAdded = useRef(1)

  /* Mirrors of two pieces of state, read from event handlers and interval
     callbacks that outlive the render they were created in.

     THE INVARIANT: every write to `savedVehicles` or `vehicleCount` bumps its
     ref at the same call site, eagerly, before the setState. All three writing
     sites hold it — the restore effect below, the add poll, and the popstate
     handler — and the two sync effects here are the backstop, not the
     mechanism.

     The eager write is the point: a ref synced ONLY by an effect is exactly as
     stale as the closure it was meant to replace during the window between a
     state write and its commit, which is the window two fast popstate events
     land in.

     It is deliberately unconditional rather than applied only where a reader
     is known to observe the gap. Two of the bumps are, today, redundant — the
     poll is not armed during a restore, and the popstate remove branch cannot
     fire while no car step is owed — but both of those are gates in OTHER
     effects, and a comment that claims a protection the code actually leaves
     to a distant gate is how this branch has repeatedly ended up asserting
     something untrue. Keep the invariant whole; it is two lines.

     Declared HERE, above the restore effect, for the same reason lastAdded is
     (see just above) plus one of its own: react-hooks/immutability rejects
     modifying a ref that an EARLIER effect already uses, so a declaration
     sitting below the restore effect — which reads and bumps both — is a lint
     error, not merely a readability problem. */
  const savedVehiclesRef = useRef(savedVehicles)
  useEffect(() => {
    savedVehiclesRef.current = savedVehicles
  }, [savedVehicles])
  const vehicleCountRef = useRef(vehicleCount)
  useEffect(() => {
    vehicleCountRef.current = vehicleCount
  }, [vehicleCount])

  /* Answers carried across a "Change answers" reload. Restored once their
     options are readable, so we never select something they do not offer. */
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current || !takeover) return
    if ((options.birthYear ?? []).length === 0) return
    restored.current = true
    let saved: {
      answers?: Record<string, string>
      idNumber?: string
      savedVehicles?: SavedVehicle[]
      view?: QuickQuoteView
    } | null = null
    try {
      const raw = window.sessionStorage.getItem("cf-qq-answers")
      saved = raw ? JSON.parse(raw) : null
    } catch {
      saved = null
    }
    if (!saved?.answers) return
    // A payload belongs to the journey that wrote it. The key is one per quote
    // origin and is consumed only once the frame reaches takeover, so a
    // "Change answers" reload that hangs at boot — documented below as roughly
    // one load in twenty — leaves it sitting there; the visitor then switches
    // product tabs, QuickQuotePanel re-points the iframe, and the new frame
    // reads it. A motor payload landing on a home frame entered the multi-car
    // block, called addVehicleOnHost against the home view model and rendered
    // "We couldn't carry over 2 of your cars — please add them again" on a
    // home-contents quote, while home's own answers were never replayed at all.
    //
    // Absent `view` means a payload written before this stamp existed. Those
    // can only be motor, since it was the only journey.
    if ((saved.view ?? "motor") !== view) return
    // Consumed only once it is OURS. Removing it before the view check
    // destroyed a payload belonging to another journey, so after the boot hang
    // below a visitor who looked at Home and came back to Vehicle found all
    // twelve motor answers gone — a worse outcome than the mis-restore the
    // check exists to prevent.
    window.sessionStorage.removeItem("cf-qq-answers")
    // Replay through set() so FSP's form and their cascades stay authoritative.
    // All state writes happen inside the async block: setting state
    // synchronously in an effect body triggers a cascading render.
    void (async () => {
      if (saved!.idNumber) setIdNumber(saved!.idNumber)
      // Gated on the flag, not just on what the payload happens to contain:
      // a two-car journey saved while multiVehicle was on must still replay
      // as ONE car on a build (or a rollback) where it is off. This is the
      // single point savedCars comes from, so it also controls firstPass
      // below — gating only the multi-car block further down and leaving
      // this ungated would read POLICY_FIELDS with no vehicle pass at all
      // whenever an old multi-car payload met a flag-off build.
      // Clamped to MAX_VEHICLES - 1 because ONE more car — the one being
      // edited when "Change answers" fired — is replayed after these. An
      // over-long list can only reach here from a build with a different cap,
      // and replaying it would put more cars into FSP's model than our own
      // journey can ever show. Clamped silently: the note below says "please
      // add them again", which would be false at the cap.
      const savedCars = multiVehicle
        ? ((saved!.savedVehicles ?? []) as SavedVehicle[]).slice(0, MAX_VEHICLES - 1)
        : []
      // A flag-off build meeting a payload a flag-on build wrote (a rollback,
      // or a session that outlived a deploy) quotes ONE car. Silently, until
      // this: the visitor asked to edit a two-car quote and would have found
      // out at the results, or not at all. Counted from the payload rather
      // than from savedCars, which is empty by the line above precisely
      // because the flag is off. This cannot fire on today's flag-off path —
      // a build with the flag off never writes a non-empty savedVehicles.
      if (!multiVehicle) {
        const dropped = ((saved!.savedVehicles ?? []) as SavedVehicle[]).length
        if (dropped > 0) setCarsNotRestored(dropped)
      }
      // One car (savedCars empty — true with the flag off, and with a
      // one-car journey either way): REQUIRED_FIELDS, exactly as before this
      // task, unchanged. Two or more cars: POLICY_FIELDS only — car 1's
      // VEHICLE_FIELDS are written explicitly below, once, into the vehicle
      // FSP's form already has. Writing them here too, only to have the
      // multi-car pass below immediately overwrite them, would pay for a
      // second make/model cascade round-trip on a path the visitor is
      // already sitting through a reload for.
      //
      // Keyed on the VIEW, and on what the view ASKED rather than what it
      // requires. Two separate defects lived on this line:
      //   - it was hardcoded to motor, so a home or buildings visitor who
      //     pressed "Change answers" got back only birth year, gender and
      //     marital status; everything about the product they were quoting was
      //     silently dropped.
      //   - the required list excludes checkboxes by design, so even per-view
      //     it would have thrown away a declared prior burglary or an elected
      //     geyser cover — answers the visitor gave and would not be shown
      //     again. askedFields is the right question here.
      // savedCars is always empty off motor, so POLICY_FIELDS stays motor's.
      const firstPass = savedCars.length > 0 ? POLICY_FIELDS : askedFields(view)
      for (const field of firstPass) {
        // Suburb is deliberately NOT replayed. set() writes through the generic
        // write(), and FSP only records a suburb when their own jQuery-UI select
        // handler runs — so replaying it filled the visible box while their model
        // kept Suburb = 0. That produced a form which passed their client-side
        // validation, returned no quotes, and told the visitor the insurers were
        // not responding. Binding the tick to their id stopped the wizard
        // CONFIRMING that suburb, but the replayed answer still satisfied
        // stepComplete's `answers[f] !== ""`, so Continue stayed enabled and the
        // dead end stayed one click away — now with a "No suburb matches
        // 'SANDTON (2196)'" message blaming the spelling of a correctly spelled
        // suburb. Leaving the answer empty disables Continue, empties the field's
        // query so no false no-match fires, and asks for a pick instead of
        // accusing anyone. The label is still saved, so restoring it properly
        // through their autocomplete can be layered on top of this.
        if (field === "suburb") {
          if (saved!.answers?.suburb) setSuburbDropped(true)
          continue
        }
        // A checkbox's "" is the ANSWER "no", not "nothing was saved", so it
        // must be replayed rather than skipped — and the presence of the KEY is
        // what distinguishes the two.
        //
        // Skipping it re-elected a declaration the visitor had declined. FSP
        // serve `geyser` pre-checked, the boot preset adopts that as "yes",
        // the visitor unticks it, and on "Change answers" the preset fires
        // again while the replay passed over the "" that would have corrected
        // it. The box came back ticked, the summary said "Yes", and the quote
        // was priced with a cover they had removed. On `alarm` or
        // `priorBurglary` the same path reverses a risk declaration.
        if (FIELD_KINDS[field].control === "checkbox") {
          if (Object.hasOwn(saved!.answers ?? {}, field)) {
            await set(field, saved!.answers![field] ?? "")
          }
          continue
        }
        const value = saved!.answers?.[field]
        if (!value) continue
        // The box shows the draft, so a restored amount has to seed it too or
        // the field renders empty over a recorded answer — the same
        // draft/answer split that made typing work, in reverse.
        if (FIELD_KINDS[field].control === "number") {
          setDrafts((d) => ({ ...d, [field]: value }))
        }
        await set(field, value)
      }

      if (savedCars.length > 0) {
        /* Vehicles must be replayed IN ORDER with an add between them: FSP's
           fields are flat and bind to the ACTIVE vehicle, so replaying car 2
           without adding first overwrites car 1. addVehicleOnHost calls their
           addVehicle directly rather than clicking their checkbox — see its
           own comment for why that is not just "the control isn't mounted".

           The two-part shape below — savedCars, then one more car — mirrors
           an asymmetry in what we actually hold: car 1 through car N-1 were
           snapshotted into savedVehicles when EACH later add was detected,
           but the LAST car, still being edited when "Change answers" fired,
           was never snapshotted (that only happens on an add) and lives in
           saved.answers instead. So car 1 is written first, into the vehicle
           FSP's form already has; savedCars[1..] follow, one add each; and
           the current car is written last, after one final add.

           `landed` starts at 1 for car 1 by CONSTRUCTION, not confirmation —
           that is the vehicle FSP's form already had before any of this ran,
           so there is nothing for addVehicleOnHost to confirm yet. Every
           car after it is counted only on a confirmed +1 from
           addVehicleOnHost, which reads their model back rather than
           trusting a call that ran without throwing. An add can still fail
           outright (their model unreachable), and claiming a car count the
           DOM does not back is the same our-model-vs-theirs divergence a
           previous task shipped a Critical over — so the state set below
           comes from what landed, never from savedCars.length + 1 outright,
           and a failed add stops the loop rather than writing the next
           car's fields into whatever vehicle happens to still be active,
           which would silently merge two cars into one. */
        for (const field of VEHICLE_FIELDS) {
          const value = savedCars[0][field]?.value
          if (value) await set(field, value)
        }
        let landed = 1
        for (let i = 1; i < savedCars.length; i++) {
          if (!addVehicleOnHost(host())) break
          for (const field of VEHICLE_FIELDS) {
            const value = savedCars[i][field]?.value
            if (value) await set(field, value)
          }
          landed++
        }
        // Only reachable once every savedCars entry actually landed — a
        // break above leaves landed short and skips this, which is what
        // stops the current car's fields being written into a vehicle that
        // was never actually added.
        if (landed === savedCars.length && addVehicleOnHost(host())) {
          for (const field of VEHICLE_FIELDS) {
            const value = saved!.answers?.[field]
            if (value) await set(field, value)
          }
          landed++
        }

        const total = savedCars.length + 1
        if (landed < total) setCarsNotRestored(total - landed)
        // Ref bumped beside the state write, as at every other site that
        // writes either of these — see the ref declarations above. Harmless
        // today (the poll is not armed during a restore, and the popstate
        // remove branch cannot fire while no car step is owed), and the point
        // is that neither reader has to KNOW that to be correct.
        const restoredVehicles = savedCars.slice(0, landed - 1)
        savedVehiclesRef.current = restoredVehicles
        setSavedVehicles(restoredVehicles)
        // Resync BEFORE the count write: the "appended car step" effect
        // treats any vehicleCount > lastAdded.current as a fresh add and
        // jumps to the last step, which for a restore would skip past the
        // "where" step's suburb re-pick gate with Continue already enabled.
        // A restore is not an add.
        lastAdded.current = landed
        vehicleCountRef.current = landed
        setVehicleCount(landed)
        // ...and owes NO car steps for what it just put back. This is the
        // third of the three rules that keep the two counts coherent (an add
        // increments both, a back-out decrements both, a restore sets the
        // count to what landed and the owed steps to zero), written at the
        // site it applies to rather than left implied by the initial value.
        //
        // Zero rather than landed - 1 because FSP's vehicle fields are flat
        // and bind to the ACTIVE vehicle: the restored earlier cars cannot be
        // edited by any step we could render, so a step per car would be four
        // screens asking the same five questions, prefilled identically, every
        // one of them writing into the last car. savedVehicles still carries
        // them into the results summary, and the MAX_VEHICLES cap still bites
        // on vehicleCount above.
        setAppendedCarSteps(0)
      }

      setStepIndex(0)
      // The reload re-used the last step's history entry, so without this Back
      // would pop to a step the restored wizard is not showing.
      window.history.replaceState({ cfStep: 0 }, "")
      // "Change answers" reloads, so the wizard remounts and the first-paint
      // guard below suppresses the focus move — leaving a visitor who asked to
      // edit with focus on <body>, the same defect the guard was added beside.
      // Bumping the nonce makes the restore an observable transition.
      setFocusNonce((n) => n + 1)
    })()
  }, [takeover, options.birthYear, set, host, multiVehicle, view])

  /* SA ID number fills year of birth and gender — two fewer questions. */
  const applyIdNumber = useCallback(
    (raw: string) => {
      setIdNumber(raw)
      if (raw.replace(/\s/g, "").length < 13) {
        setIdNote(null)
        return
      }
      // sast-exempt: this is a "use client" component, so the getter runs in
      // the staff member's browser, which is already in SAST. (The SERVER
      // copy of this century inference, in lib/validation/client-wizard.ts,
      // is NOT exempt — there the container is UTC and an ID whose two-digit
      // year equals the incoming year is misread by a century for two hours
      // on 1 January.)
    const derived = detailsFromSaIdNumber(raw, new Date().getFullYear())
      if (!derived) {
        setIdNote("We couldn't read that ID number — just answer the two questions below instead.")
        return
      }
      const root = host()
      if (!root) return
      const yearOption = options.birthYear?.find((o) => o.label === String(derived.birthYear))
      const genderOption = options.gender?.find((o) => o.label === derived.gender)
      if (yearOption) void set("birthYear", yearOption.value)
      if (genderOption) void set("gender", genderOption.value)
      setIdNote(
        yearOption
          ? `Thanks — born ${derived.birthYear}, ${derived.gender.toLowerCase()}. Change it below if that's wrong.`
          : "We couldn't match that to our list — please pick below.",
      )
    },
    [host, options.birthYear, options.gender, set],
  )

  /* Their "panel finished" confirmation, tracked SEPARATELY from the reveal.
     The settle effect stops at `settled` and disposes its subscription, so a
     signal arriving after the list is on screen would never be heard and the
     badge would stay withheld for a panel that had in fact finished. This one
     outlives the reveal for exactly that reason. */
  useEffect(() => {
    if (!submitted || panelComplete) return
    const done = allQuotesDone(host())
    // No signal at all: the debounce is then the best evidence available, and
    // withholding the claim forever would delete the feature on any change to
    // their model rather than degrade with it. Same posture the reveal takes.
    if (!done) {
      const t = window.setTimeout(() => setPanelComplete(true), 0)
      return () => window.clearTimeout(t)
    }
    // Deferred rather than read inline: a synchronous state write during effect
    // setup triggers a cascading render, which this file has been bitten by.
    const initial = window.setTimeout(() => {
      if (done() === true) setPanelComplete(true)
    }, 0)
    const sub = done.subscribe((v) => {
      if (v === true) setPanelComplete(true)
    })
    return () => {
      window.clearTimeout(initial)
      sub.dispose()
    }
  }, [submitted, panelComplete, host])

  /* Count FSP's rendered quote rows so the wait screen reports real arrivals
     rather than a decorative animation. */
  /* Tell the embedding page the visitor has started.

     FSP take initialView at init and expose no way to change quote type in
     place, so switching the product tab necessarily re-initialises this frame
     and discards everything entered. The panel needs to know whether that
     costs anything before doing it silently. Posted once, on the first answer:
     started is not a state you can leave. */
  const reportedDirty = useRef(false)
  useEffect(() => {
    if (reportedDirty.current) return
    if (Object.keys(answers).length === 0) return
    if (window.parent === window) return
    reportedDirty.current = true
    window.parent.postMessage({ type: QUOTE_FRAME_DIRTY_MESSAGE, dirty: true }, "*")
  }, [answers])

  /* Let the re-sort play before handing over. panelComplete flips, the arrival
     reorders, and only then does QuickQuoteResults take the screen. Without
     this the handover lands 400ms into a 900ms transition. */
  useEffect(() => {
    if (!shouldHoldForResort(panelComplete, arrived.length, resortPlayed)) return
    const t = window.setTimeout(() => setResortPlayed(true), RESORT_HOLD_MS)
    return () => window.clearTimeout(t)
  }, [panelComplete, arrived.length, resortPlayed])

  useEffect(() => {
    if (!submitted || settled) return
    const root = host()
    if (!root) return
    let settleTimer: number | null = null
    // Flipped by FSP's own signal below. Until then every reveal is a guess
    // about whether more quotes are coming, and has to be a patient one.
    let panelDone = false

    // FSP tell us when their panel is finished, so the blind debounce is a
    // fallback for when they don't, not the normal path. Measured on a real
    // panel: rows complete around 6.6s, revealed at 10.9s — four and a half
    // seconds of a finished list sitting behind a progress bar, every time.
    //
    // Their signal must also be able to HOLD BACK the reveal, not only shorten
    // it. On a staggered panel 4 rows landed at 11.9s, SETTLE_MS fired at 16.4s
    // and badged R897.71 as "Best price" while allquotesdone still read FALSE —
    // and the real cheapest, R729.60, arrived at 17.1s. We held authoritative
    // evidence the panel was unfinished and revealed anyway, which is the exact
    // failure SETTLE_MS was introduced to prevent. Confirmed closed on two real
    // staggered panels: the reveal now lands 400ms after the signal, with the
    // correct badge from first paint rather than corrected a second later.
    //
    // Declared BEFORE arm(), which reads it. It was below, and a row already on
    // screen when count() first ran would have thrown a temporal-dead-zone
    // ReferenceError out of the effect and hung the wait screen for good. tsc
    // does not catch that: the read is inside a closure.
    const done = allQuotesDone(root)

    const arm = () => {
      if (settleTimer) window.clearTimeout(settleTimer)
      // The attribute (which hides FSP's own list) is NOT set here — that
      // hid their results before we knew ours had parsed, so a parse failure
      // produced a blank screen instead of degrading to their UI. It is set
      // by onParsed below, once ours is confirmed on screen.
      //
      // Decision lives in the bridge so it can be tested — see settleDelay.
      const delay = settleDelay(panelDone, Boolean(done), {
        paint: PAINT_MS,
        signalSilent: SIGNAL_SILENT_MS,
        blind: SETTLE_MS,
      })
      settleTimer = window.setTimeout(() => setSettled(true), delay)
    }

    /* Rows FSP rendered that we could actually show. This drives the wait
       screen's count and waitingStage's evidence floor, both of which should
       mean "quotes we can display" — a row with no premium is not evidence
       that the panel is answering. It deliberately does NOT gate the reveal:
       see arm() below. */
    const usableRows = () =>
      [...root.querySelectorAll<HTMLElement>(".quotes .dataRow")].filter(
        (row) => (row.querySelector(".rightCol .premium")?.textContent ?? "").trim() !== "",
      ).length

    /* Their rows carry REAL "I'm interested" buttons that email a person.
       These were only neutralised in onParsed, i.e. after settle — so for the
       whole arrival window (up to SIGNAL_SILENT_MS, and 45s at the backstop)
       they sat visible and in the tab order behind our wait screen, where a
       keyboard or screen-reader visitor could submit a genuine lead having
       never seen a quote. Their form is made inert the instant takeover is
       decided; their results list had no equivalent. Applied as rows arrive.
       onParsed still un-inerts if OUR parse yields nothing, which is the
       degrade-to-their-UI path and must keep working. */
    const shieldTheirRows = () => {
      root.querySelectorAll<HTMLElement>(".quotes").forEach((el) => {
        if (el.hasAttribute("inert")) return
        el.setAttribute("inert", "")
        el.setAttribute("aria-hidden", "true")
      })
    }

    const count = () => {
      const n = usableRows()
      setQuoteCount(n)
      const parsed = extractQuotes(root)
      /* Only re-render when the parse actually changed. The observer fires on
         every mutation anywhere in their subtree, and setArrived always builds
         a new array, so React can never bail out on identity the way it does
         for the primitive above. */
      setArrived((prev) => (sameArrival(prev, parsed) ? prev : parsed))

      /* HIDE THEIR RAW LIST FOR EXACTLY THE WINDOW OURS IS SHOWING IT.
         data-cf-takeover hides their FORM; data-cf-results hides their
         QUOTES, but only once our results screen is up. That left the arrival
         window — rows landing, our list rendering — with FSP's own unsorted,
         unbadged rows visible directly beneath ours: the same five quotes
         twice, one of them contradicting the ordering we had just performed.

         Keyed on OUR parse succeeding, which is the same condition that
         renders the arrival. If we cannot parse their rows, `parsed` is empty,
         the attribute never goes on, and their list stays visible — the
         degrade-to-FSP path is preserved rather than blanked. */
      if (parsed.length > 0) root.setAttribute("data-cf-arrival", "true")
      else root.removeAttribute("data-cf-arrival")
      if (root.querySelector(".quotes .dataRow")) shieldTheirRows()
      // Revealing on the FIRST row dropped the visitor into a list holding one
      // quote while others were still arriving — and, because the wait screen
      // unmounted at that moment, its live counter could never render at all.
      // Wait for arrivals to stop before handing over.
      // Armed on ANY row of theirs, not only ones WE can parse. Gating this on
      // usable rows made `settled` imply `quotes.length >= 1`, which made
      // onParsed(0)'s un-inert branch — the degrade-to-their-UI path — dead
      // code: if FSP move `.rightCol .premium`, their list still works and
      // ours does not, and the visitor would have waited 45s to be told "the
      // insurers aren't responding" over their real, visible quotes. Their
      // having rows is the signal to stop waiting; our being able to render
      // them is a separate question, answered by onParsed.
      if (root.querySelector(".quotes .dataRow")) arm()
    }

    const markDone = () => {
      panelDone = true
      // Only re-arm if something is actually on screen; with no rows this is a
      // failed run and failAt below owns it.
      if (root.querySelector(".quotes .dataRow")) arm()
    }
    let doneSub: { dispose(): void } | null = null
    if (done) {
      if (done() === true) markDone()
      else doneSub = done.subscribe((v) => { if (v === true) markDone() })
    }

    count()
    const observer = new MutationObserver(count)
    observer.observe(root, { childList: true, subtree: true })

    // Their own maxQuoteTime is 120s; a visitor should not be asked to wait
    // that long on a screen with no exit.
    // Only a timeout with NOTHING to show is a failure. Armed against the row
    // count, not the clock alone: an earlier version declared "the insurers
    // aren't responding" — assertively, via role="alert" — while five priced
    // quotes sat counted on the same screen.
    const failAt = window.setTimeout(() => {
      // With nothing to show this is a failed run. With rows in hand but their
      // signal never arriving, waiting longer serves nobody — reveal what we
      // have rather than hold a finished-looking list behind a progress bar
      // forever, which is what waiting on a signal alone would risk.
      // "The insurers aren't responding" is only true when THEY returned
      // nothing. Rows we cannot parse are our problem, and reveal + degrade
      // to their own working list serves the visitor better than an alert.
      if (!root.querySelector(".quotes .dataRow")) setTimedOut(true)
      else setSettled(true)
    }, 45000)

    return () => {
      observer.disconnect()
      doneSub?.dispose()
      if (settleTimer) window.clearTimeout(settleTimer)
      window.clearTimeout(failAt)
    }
  }, [submitted, settled, host])

  /* Clamped, because three sites below dereference step.title, step.heading
     and step.fields with no guard, and the step list can SHRINK — a back-out
     removes an appended step. A stale index would crash the wizard rather
     than clamp it, and "degrade, never trap" is the rule this whole file is
     built on. It masks nothing: the popstate handler's own clamp still runs
     and is still the thing that decides where the visitor actually is. */
  const step = steps[Math.min(stepIndex, steps.length - 1)]
  const stepComplete = step?.fields.every((f) => !isUnanswered(f, answers))
  const firstMissing = step?.fields.find((f) => isUnanswered(f, answers))
  const isLastStep = stepIndex === steps.length - 1
  /* Is their vehicle count readable at all?
     Offering the add control while it is not would let a visitor commit a car
     we never ask about: their `saveVehicle` would run, FSP would hold two
     vehicles, and the poll below — which learns about an add ONLY by watching
     that count — would never notice. That is a worse journey than today's,
     which never offers the control. "Degrade, never trap" covers the read
     failing safely; it does not make offering a control we cannot observe
     safe.
     Read HERE, in an effect, rather than inside showMoreCars below, because
     that expression is evaluated during render and a render that reads the
     DOM is not pure — the same objection this branch raised against a DOM
     read inside a state updater. Polled rather than latched so it can go
     false again, which is what the old per-render read did.
     Deliberately not folded into the add-detection poll: that one must arm on
     the control having been offered, and offering it depends on this — so one
     effect owning both facts cannot bootstrap. */
  useEffect(() => {
    if (!multiVehicle || !takeover) return
    const root = host()
    if (!root) return
    const poll = window.setInterval(() => {
      setCountReadable(vehicleCountFrom(root) !== null)
    }, 500)
    return () => window.clearInterval(poll)
  }, [multiVehicle, takeover, host])

  /* Their control validates the whole active vehicle, so it can only work on
     the final step with everything answered — see canAddVehicle. */
  const showMoreCars =
    multiVehicle &&
    isLastStep &&
    stepComplete &&
    canAddVehicle(answers) &&
    vehicleCount < MAX_VEHICLES &&
    countReadable

  /* Reveal FSP's OWN add-a-car control rather than building one.
     The takeover parks their form at left:-10000px with overflow:hidden and a
     1px box, so a child cannot be revealed in place — the node has to move.
     Moving it is safe: their `saveVehicle` validates `#tVehicles select`, and
     those selects stay behind inside the form, so the validation it gates on is
     untouched. Knockout registers `click` on the node itself, so the binding
     travels with it.
     Absence is not an error: if their markup moves, no control is offered and
     this is exactly today's wizard.
     Placed here rather than beside the other effects above: it closes over
     showMoreCars, which is a const declared at this point in the function —
     a dependency array is evaluated eagerly as the useEffect call executes,
     not deferred into a closure, so putting this earlier would read
     showMoreCars before its declaration and throw (tsc: TS2448/TS2454). See
     the `done` comment above the settle effect for the sibling case where
     that same ordering hazard hid inside a closure instead.
     MEASURED, not inferred (quote-staging, 2026-08-08): FSP rebuild the whole
     vehicle subtree on every add. `addVehicle()` calls `policy.valueHasMutated()`,
     and `#tVehicles` is `data-bind="with: $root.activeVehicle"`, so knockout
     tears the subtree down and re-renders it around the new vehicle.
     Immediately after an add, the row, its parent, and the checkbox captured
     below are ALL detached — `#morevehicles` in the document afterwards is a
     DIFFERENT node. The captured references are therefore only valid while no
     car has been added; that is also why this effect re-queries by id on
     every run rather than caching the node — a fresh lookup finds FSP's
     current control, a cached one would not. */
  useEffect(() => {
    const mount = moreCarsRef.current
    if (!mount) return
    const root = host()
    const checkbox = root?.querySelector<HTMLElement>("#morevehicles")
    const row = checkbox?.closest<HTMLElement>(".dataRow")
    if (!row) return
    const home = row.parentElement
    const next = row.nextSibling
    mount.appendChild(row)
    return () => {
      // Put it back where it came from — but only if "where it came from"
      // still exists. If a car was added while the control sat in our panel,
      // FSP already tore `home` out of the document (see the measured note
      // above), and insertBefore on a detached parent does not throw — it
      // silently succeeds into a subtree nobody can reach, taking the node
      // out of wherever it currently lives on the way, so skipping this
      // check would make this comment claim a restore that, on that path,
      // never happens. The path this DOES matter for — leaving the last step
      // without adding a car — never tears the subtree down, so home stays
      // connected and the restore runs exactly as before.
      if (home?.isConnected) home.insertBefore(row, next)
    }
  }, [showMoreCars, host])

  /* Kept fresh so the poll below can read the LATEST answers/options without
     the effect itself depending on them — see the note on that effect for
     why depending on them directly loses adds. */
  const answersRef = useRef(answers)
  useEffect(() => {
    answersRef.current = answers
  }, [answers])
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])
  /* Latched the first time their control is actually offered. It only ever
     goes true, which is what makes it safe to arm the poll below on — see
     there.
     Deferred rather than written inline, like the restore and panelComplete
     effects above: a synchronous state write during effect setup triggers a
     cascading render. The delay costs nothing — the control has to be
     rendered and moved into our panel before anyone can tick it. */
  useEffect(() => {
    if (!showMoreCars || moreCarsOffered) return
    const t = window.setTimeout(() => setMoreCarsOffered(true), 0)
    return () => window.clearTimeout(t)
  }, [showMoreCars, moreCarsOffered])

  /* Their control is theirs, so we learn about an add by watching their model
     rather than by handling the click. saveVehicle refuses silently when the
     vehicle does not validate, so a click proves nothing and the count proves
     everything.

     THERE IS NO BASELINE. An earlier version captured `seen` when the effect
     armed and fired on `now > seen`, which made every teardown of this effect
     a chance to lose an add for good: re-arming captured `seen` at the CURRENT
     count, so `now > seen` could never be true again, FSP held a car we never
     asked about, and it silently absorbed every later edit. That was fixed
     once by pulling answers/options out of the deps; arming on `showMoreCars`
     was the remaining way in, because it is derived from `answers` and
     `stepIndex` and anything flipping it false inside the ≤200ms detection gap
     — a Back press, blanking a licence select — tore the poll down mid-add.
     Comparing against a ref that TRACKS our count removes the concept
     entirely: there is nothing a re-arm can reset.

     Armed on the latch instead, which only ever goes true, so this effect's
     deps are all stable and it neither tears down nor re-arms for the life of
     the journey. That also lets one interval serve every add — the ref is
     bumped eagerly below, so the next tick compares against the new count
     rather than re-detecting the same car.

     TWO LOCKS keep this poll off the restore, which calls addVehicleOnHost
     itself: a poll running during the replay would read those adds as the
     visitor's, snapshot half-written answers, clear VEHICLE_FIELDS mid-replay
     and corrupt the restore. The first lock is the latch — it requires
     showMoreCars, hence isLastStep, and a restore lands on step 0. The second
     is that a browser Back arriving mid-replay cannot reach the last step
     either: the replay deliberately skips `suburb` (see the long note in the
     restore effect), so furthestReachableStep clamps any popped target to 1,
     the "where" step.
     THE SECOND LOCK IS LOAD-BEARING AND EASY TO REMOVE BY ACCIDENT. That same
     suburb note says restoring it properly through FSP's autocomplete "can be
     layered on top of this" — doing that makes the restored journey complete,
     un-clamps the pop, and hands step 3 back to a Back press mid-replay. If
     you implement the suburb replay, gate this poll on the restore being
     finished rather than relying on the clamp.

     Still NOT dependent on answers/options, even though the snapshot below
     reads both: they are read through refs at poll time so a keystroke cannot
     disturb the poll while still snapshotting current values when the add is
     actually seen. */
  useEffect(() => {
    // Stopped once the quote is in. Their model has no reason to gain a
    // vehicle after submit, but if it ever did, this poll would push a
    // snapshot and clear VEHICLE_FIELDS while the visitor is reading their
    // quotes — rewriting the results summary under them. Closing an exposure,
    // not fixing an observed bug. The retry path sets submitted false again,
    // and re-arming is safe precisely because there is no baseline to lose.
    if (!multiVehicle || !moreCarsOffered || submitted) return
    const root = host()
    if (!root) return
    const poll = window.setInterval(() => {
      const now = vehicleCountFrom(root)
      if (now === null || now <= vehicleCountRef.current) return
      // Eagerly, BEFORE the state writes below: the ref's own sync effect only
      // runs after React commits, and this interval can tick again in between.
      // A second detection of the same car would push a duplicate snapshot and
      // owe a step for a car nobody added.
      vehicleCountRef.current = now
      const currentAnswers = answersRef.current
      const currentOptions = optionsRef.current
      // Snapshot the car just saved, then clear ONLY the per-vehicle answers.
      // Leaving them would show car 1's model in car 2's select while FSP's form
      // held nothing — an answer we display that their model does not have, which
      // is the defect write()'s return value exists to prevent.
      //
      // Value AND label, captured here because this is the last moment both are
      // available: the options list mapping "040" to "AUDI" belongs to the car
      // being replaced and is cleared further below, once the snapshot and the
      // answer clear are done.
      //
      // Built OUTSIDE the updater so the ref can be bumped with the same
      // object the state receives — see the ref declarations above for why
      // every write to this state bumps its ref at the call site.
      const snapshot = Object.fromEntries(
        VEHICLE_FIELDS.map((f) => {
          const value = currentAnswers[f] ?? ""
          return [f, { value, label: currentOptions[f]?.find((o) => o.value === value)?.label ?? value }]
        }),
      ) as SavedVehicle
      savedVehiclesRef.current = [...savedVehiclesRef.current, snapshot]
      setSavedVehicles((v) => [...v, snapshot])
      setAnswers((a) => {
        const cleared = { ...a }
        for (const f of VEHICLE_FIELDS) delete cleared[f]
        return cleared
      })
      setOptions((o) => ({ ...o, make: [], model: [] }))
      setVehicleCount(now)
      // An add is the one event that increments BOTH counts: FSP hold another
      // car, and the visitor is owed a step to describe it. A restore moves
      // them apart; this is where they move together.
      setAppendedCarSteps((n) => n + 1)
      setBlocked(false)
      // A genuine add is the recovery from a restore that could not carry
      // every car over — the visitor just did what the note below asked.
      setCarsNotRestored(0)
    }, 200)
    return () => window.clearInterval(poll)
  }, [multiVehicle, moreCarsOffered, submitted, host])

  /* The appended car step is the point of the add, so go there. Pushed, not
     replaced, so browser Back walks back to the licence step rather than
     leaving the quote — the behaviour every other forward move in this
     wizard has. lastAdded itself is declared earlier, beside the restore
     effect — see the comment there for why. */
  useEffect(() => {
    if (vehicleCount === lastAdded.current) return
    // vehicleCount also DROPS — the popstate handler decrements it when a
    // visitor backs out of a car step, having already set stepIndex and
    // consumed the history entry for that. Only an INCREASE is an add this
    // effect should act on; a decrease still has to resync lastAdded (set
    // eagerly below, not in the deferred callback — see that note), or a
    // later re-add from the lower count would read as "already handled" and
    // silently do nothing.
    const wasAdd = vehicleCount > lastAdded.current
    // Set eagerly, not in the deferred callback: this only stays correct
    // because the effect's deps are exactly [vehicleCount, steps.length].
    // Don't add a THIRD dep. steps.length is derived from vehicleCount AND
    // appendedCarSteps, and an add moves both in a single commit — so the two
    // deps change together and this effect runs once, with the new step list
    // already in hand. (A restore moves only vehicleCount, and resyncs
    // lastAdded before writing it, so the guard above returns.) The actual
    // hazard is a genuinely independent
    // value changing between this line and the timeout firing: that re-runs
    // the effect, clears the pending timeout in cleanup, and then hits the
    // `vehicleCount === lastAdded.current` guard above — already true, since
    // this line set it on the FIRST run — so setStepIndex silently never
    // lands and the visitor is left on the licence step with a history entry
    // still pointing at the car step they never reached.
    lastAdded.current = vehicleCount
    if (!wasAdd) return
    const target = steps.length - 1
    window.history.pushState({ cfStep: target }, "")
    // Deferred rather than set inline: a synchronous state write during
    // effect setup triggers a cascading render, which this file has been
    // bitten by — see the restore effect and the panelComplete effect above.
    const t = window.setTimeout(() => {
      setStepIndex(target)
      setFocusNonce((n) => n + 1)
    }, 0)
    return () => window.clearTimeout(t)
  }, [vehicleCount, steps.length])

  /* Carries the answers across a deliberate reload. Shared by "Change answers"
     and by Back from the results, which are the same intent by two routes. */
  const reloadWithAnswers = useCallback(() => {
    try {
      window.sessionStorage.setItem(
        "cf-qq-answers",
        // Stamped with the view that wrote it — see the consumer.
        JSON.stringify({ view, answers, idNumber, savedVehicles }),
      )
    } catch {
      // Private browsing or a full quota: fall through to a plain reload
      // rather than trapping the visitor on a dead screen.
    }
    window.location.reload()
  }, [answers, idNumber, savedVehicles, view])

  /* Browser Back — which on a phone is the primary navigation gesture, not a
     rare one — left the quote entirely and took all twelve answers with it.
     There were no history entries at all, so the first Back from step 2 exited
     the page and Forward returned an empty step 1.

     Each forward step now pushes an entry, so Back walks the steps instead.
     Our own Back button calls history.back() rather than setting state, so the
     two cannot disagree: there is one mechanism, and the button is a shortcut
     to it. Step 0 pushes nothing, so Back from the first step still leaves —
     someone who wants out must be able to get out. */
  useEffect(() => {
    if (!takeover) return
    // Tag the entry the wizard opened on. Without this the first Back popped to
    // a null state, the handler had no step to read, and the visitor sat on the
    // same step wondering why nothing happened — a dead Back rather than a
    // destructive one. Only ever written when untagged, so a pushed step or a
    // restore's re-tag is never clobbered by this effect re-running.
    if ((window.history.state as { cfStep?: unknown } | null)?.cfStep === undefined) {
      window.history.replaceState({ cfStep: 0 }, "")
    }
    const onPop = (event: PopStateEvent) => {
      // On the results screen the answers are all that Back can sensibly mean,
      // and their submit control is gone for good — so it takes the same route
      // "Change answers" does rather than popping to a step behind a screen
      // that is still showing quotes.
      if (submitted) {
        reloadWithAnswers()
        return
      }
      const target = (event.state as { cfStep?: unknown } | null)?.cfStep
      if (typeof target !== "number") return
      setBlocked(false)

      // Leaving a car step BACKWARDS is the exact inverse of adding one, and
      // has to be mirrored here before the clamp below runs. Clearing
      // VEHICLE_FIELDS on add removes overnightParking and vehicleUse, which
      // live on the "where" step, not the car step — so without restoring
      // them, that step reads incomplete, furthestReachableStep clamps the
      // visitor two steps short of where the popped entry actually points,
      // and anything they then type writes into FSP's ACTIVE vehicle, which
      // is still the one they believed they had left.
      //
      // removeActiveVehicleFrom mirrors FSP's own inverse (MEASURED,
      // quote-staging 2026-08-08: a full inverse of addVehicle — vehicle
      // count drops by one and the previous vehicle's answers and licence
      // fields are restored in their DOM). Doing that first means the clamp
      // below sees a journey that is genuinely complete, rather than one
      // still missing the car it already backed out of — no special case is
      // added to furthestReachableStep itself.
      //
      // Covers both routes to a pop: our Back button only ever calls
      // history.back() and never sets state directly (see the comment above
      // this effect), so this handler is the one place either route — the
      // button, or the browser's own back gesture — actually lands.
      let resolvedAnswers = answersRef.current
      let resolvedSteps = steps
      // An appended car step is the only place this can fire, and after a
      // restore there are none: a restore owes zero steps, so steps.length is
      // WIZARD_STEPS.length and this test is provably false. That is the whole
      // point of splitting the two counts — it is what stops Back deleting a
      // car the visitor never added in this session.
      // Gated on the view as well: WIZARD_STEPS is MOTOR's list, and comparing
      // a home journey's index against motor's length reads as general when it
      // is not. Home has three steps and buildings two, so the branch is
      // unreachable on them today — but only by arithmetic, which is exactly
      // the kind of accident that stops holding when a step is added.
      if (view === "motor" && stepIndex >= WIZARD_STEPS.length && target < stepIndex) {
        // Read from the ref, not the closure. Two popstate events can land
        // before this effect re-subscribes (passive effects flush after paint,
        // so that window exists, however narrow), and the closure would then
        // hand pop B the SAME saved car pop A already consumed — restoring the
        // wrong car's values, leaving the option lists and the answers
        // disagreeing, and putting blank selects behind an enabled Continue.
        //
        // Looked up BEFORE calling remove, not after: savedVehicles.length
        // === vehicleCount - 1 by construction — one snapshot per add, and a
        // restore writes the pair together (savedCars.slice(0, landed - 1)
        // alongside setVehicleCount(landed), in the restore effect above) — so
        // this should never be empty here. If that invariant ever broke,
        // removing first would tear a vehicle out of FSP's model while ours
        // still claimed two cars, which is worse than doing nothing. Latent
        // today, closed at no cost by ordering the checks this way.
        const remaining = savedVehiclesRef.current
        const restored = remaining[remaining.length - 1]
        const root = host()
        // THEIR count, read live, not ours read from a closure — and floored
        // at one vehicle. Three fast pops against a stale closure count would
        // each pass a `vehicleCount > 1` test written from React state and
        // drive FSP's Vehicles to ZERO: a submission with no vehicle in it at
        // all. A live read cannot be stale, and the floor means the worst a
        // race can do is refuse.
        const live = vehicleCountFrom(root)
        if (root && restored && live !== null && live > 1 && removeActiveVehicleFrom(root)) {
          const withCarRestored = { ...resolvedAnswers }
          for (const f of VEHICLE_FIELDS) withCarRestored[f] = restored[f]?.value ?? ""
          resolvedAnswers = withCarRestored
          // Eager ref write beside every state write below, for the same
          // reason the read above uses the ref: these values DO outlive this
          // invocation as committed state, and the next pop must see them.
          answersRef.current = withCarRestored
          setAnswers(withCarRestored)
          savedVehiclesRef.current = remaining.slice(0, -1)
          setSavedVehicles((v) => v.slice(0, -1))
          // From the live count, which removeActiveVehicleFrom just verified
          // dropped by exactly one. A plain write is correct here precisely
          // BECAUSE the value came from FSP rather than from React: a second
          // pop re-reads their model and either sees the new count and
          // refuses at the floor, or removes for real and writes its own
          // verified value. An updater form would instead chain arithmetic
          // onto a number nothing had re-verified.
          const newCount = live - 1
          // The owed count is ours alone — FSP know nothing about it, so
          // there is no live read to prefer and the WRITE takes the updater
          // form, which builds on React's latest committed value rather than
          // on this closure's. The local below is only for resolvedSteps,
          // which is consumed inside this same invocation.
          const newAppended = Math.max(0, appendedCarSteps - 1)
          resolvedSteps = buildSteps(newCount, newAppended)
          vehicleCountRef.current = newCount
          setVehicleCount(newCount)
          setAppendedCarSteps((n) => Math.max(0, n - 1))

          // Make/model options were cleared to [] on add and nothing else
          // restores them. removeActiveVehicle() repopulates FSP's own
          // selects SYNCHRONOUSLY — MEASURED, quote-staging 2026-08-08: 56
          // make options and 125 model options present in the SAME tick, no
          // AJAX, no polling. Read eagerly, here, rather than inside the
          // setOptions updater below: an updater is React-owned code that
          // runs during the render phase, not at the call site — under
          // StrictMode's dev double-invoke, or an interrupted-and-restarted
          // concurrent render, it can run more than once at an unpredictable
          // moment, and a DOM read has no business being impure like that.
          // Reading here, once, at the moment the measurement above actually
          // describes, is what makes the code match both the comment and the
          // measurement.
          //
          // Without this restore, a controlled select whose value matches no
          // option in an empty list renders BLANK: the restored answers would
          // read as lost even though stepComplete is true and Continue is
          // enabled, and a submission from there would fall through to the
          // raw code ("041") instead of the label — exactly what storing the
          // label alongside the value exists to prevent.
          const makeOptions = readOptions(control(root, "make"))
          const modelOptions = readOptions(control(root, "model"))
          setOptions((o) => ({ ...o, make: makeOptions, model: modelOptions }))
        } else {
          // The car did NOT leave FSP's model — their model was unreachable,
          // the remove removed nothing, savedVehicles was empty, or the floor
          // refused. Their active vehicle is therefore still car 2.
          //
          // Falling through to the clamp here is not a degrade, it is the
          // Critical from the add-a-car task re-entered: the clamp would land
          // the visitor on the "where" step with the vehicle answers blank —
          // that step asks overnightParking and vehicleUse — and everything
          // they typed there would be written into car 2 while they believed
          // they were fixing car 1. Silent, wrong, and about a priced
          // financial product.
          //
          // So keep them exactly where they are. The pop consumed a history
          // entry, so push it back to keep the stack and the step in step;
          // Back then genuinely does nothing rather than doing damage.
          window.history.pushState({ cfStep: stepIndex }, "")
          return
        }
      }

      // A popped index is a request, not an authority. "Change answers" reloads
      // in place, so the entries BEHIND the restored one still carry the step
      // indices of a journey that no longer exists — and honouring them walked
      // the visitor FORWARD past the step holding the suburb gate, into a form
      // that could not be quoted and ended on "The insurers aren't responding".
      // One keystroke from a screen every editing customer sees.
      setStepIndex(
        Math.min(
          Math.max(target, 0),
          furthestReachableStep(resolvedAnswers, resolvedSteps),
          resolvedSteps.length - 1,
        ),
      )
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
    // `answers`, `savedVehicles` and `vehicleCount` are deliberately absent:
    // the handler reads the first two through refs and the third live from
    // FSP, precisely so a pop cannot act on a value this closure captured. Do
    // not add them back to "keep it fresh" — a fresher closure is not what
    // makes the double-pop safe, and listing an unread value is a lint error.
  }, [takeover, submitted, reloadWithAnswers, steps, stepIndex, appendedCarSteps, host, view])

  const submit = useCallback(() => {
    const root = host()
    const button = root?.querySelector<HTMLButtonElement>("form#quotationDetails button[type=submit]")
    if (!button) {
      // Once quotes land, their knockout app removes the submit control, so
      // the form cannot be resubmitted in place. Returning silently left the
      // visitor pressing a dead button with no feedback and no way out.
      setSubmitError("restart")
      return
    }

    setSubmitError(null)
    button.click()

    // Their savequote() runs jQuery Validate first and returns early when the
    // form is invalid. Those errors render inside the form we park off-screen,
    // so an earlier version set submitted=true unconditionally and the visitor
    // watched a progress bar sit at 95% forever with no error, no timeout and
    // no way back. Read their outcome before committing to the wait screen.
    window.setTimeout(() => {
      const started = !!root?.querySelector("#quotesLoadingModal")
      if (started) {
        setSubmitted(true)
        return
      }
      const messages = [...(root?.querySelectorAll("label.error, .field-validation-error, .error") ?? [])]
        .map((el) => (el.textContent ?? "").trim())
        .filter((t) => t.length > 3)
      setSubmitError(
        messages[0] ??
          "We couldn't submit that — please check your answers and try again.",
      )
    }, 400)
  }, [host])

  if (!ready) {
    /* The skeleton shows the rail, heading and labels of the view that is
       actually arriving — it takes `view` for exactly that reason.

       It used to be motor-only, behind a neutral "Loading the insurer panel…"
       line for the other two, because the wizard took over motor and nothing
       else: missingFields demanded all twelve vehicle fields, which a home or
       buildings form does not have, so takeover never happened there and the
       motor skeleton would have promised "Your car / Your driving" before
       revealing somebody else's form. Now that missingFields is per-view all
       three take over, and a per-view skeleton is accurate on each — so the
       gate is gone rather than merely relaxed.

       Reserves the real form's space. This used to be a 118px line of text
       against a 635px wizard, so the swap moved everything below it by ~1000px
       in the embedding page. */
    return <QuickQuoteBootSkeleton view={view} />
  }

  // Their widget never came up, so there is no form for the stylesheet to
  // reveal. Rendering null here left the visitor with marketing copy, a
  // "Loading the insurer panel…" that vanished, and then nothing at all — no
  // error, no retry, no number, permanently. Same recovery the quote timeout
  // already offers, because it is the same problem from the visitor's side.
  if (!takeover && bootFailed) {
    return (
      <div className="cf-wait" role="alert">
        <p className="cf-wait-eyebrow">Something went wrong</p>
        <h2 className="cf-wait-heading">We couldn&apos;t load the insurer panel</h2>
        <p className="cf-wait-meta">
          This is on our side, not yours. Reload to try again, or give us a call on{" "}
          <a href="tel:+27105000000">010 500 0000</a> and we&apos;ll quote you over the
          phone.
        </p>
        <button
          type="button"
          className="cf-wiz-next cf-wait-retry"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    )
  }

  // Their form is revealed by the stylesheet when this attribute is absent.
  if (!takeover) return null

  // Once submitted we hold the screen with our own wait state until FSP's
  // results land; the themed results below then take over.
  if (submitted) {
    if (settled && !shouldHoldForResort(panelComplete, arrived.length, resortPlayed)) {
      return (
        <QuickQuoteResults
          host={host()}
          summary={
            // savedVehicles.length === vehicleCount - 1 by construction —
            // one snapshot per add, and a restore writes the pair together
            // (see the restore effect and the popstate handler above) — so
            // this is equivalent to "is there more than one car" without
            // relying on vehicleCount alone.
            //
            // Flag-off / single car: today's expression, UNCHANGED. Grouping
            // policy-then-vehicle (the else branch, needed once there are 2+
            // cars) is mutually exclusive with today's order — WIZARD_STEPS
            // interleaves suburb (policy) with overnightParking/vehicleUse
            // (vehicle) inside the "where" step, so ANY policy/vehicle
            // grouping reorders a single-car summary. QuickQuoteResults
            // renders this array with no sort, so the row order IS the
            // output a visitor sees — do not "simplify" the two arms into
            // one; that would silently reorder a live surface.
            vehicleCount === 1 && savedVehicles.length === 0
              ? steps.flatMap((st) =>
                  st.fields.map((f) => ({
                    label: LABELS[f],
                    value: summaryValue(f, answers[f], options[f]),
                  })),
                )
              : // Two or more cars: policy rows first, then one block per car
                // — "your details, then Car 1, then Car 2" is how a person
                // reads a multi-car quote.
                [
                  ...POLICY_FIELD_STEP_ORDER.map((f) => ({
                    label: LABELS[f],
                    value: summaryValue(f, answers[f], options[f]),
                  })),
                  ...[...savedVehicles, Object.fromEntries(
                    VEHICLE_FIELDS.map((f) => {
                      const value = answers[f] ?? ""
                      return [f, { value, label: options[f]?.find((o) => o.value === value)?.label ?? value }]
                    }),
                  ) as SavedVehicle].flatMap((vehicle, i) =>
                    VEHICLE_FIELD_STEP_ORDER.map((f) => ({
                      label: `Car ${i + 1} — ${LABELS[f]}`,
                      // The LABEL, never the value. Task 5 captured it at save time precisely
                      // so this line cannot print FSP's raw codes ("040") at a customer.
                      value: vehicle[f]?.label || "—",
                    })),
                  ),
                ]
          }
          panelComplete={panelComplete}
          onParsed={(count) => {
            const root = host()
            if (!root) return
            /* The arrival is over either way; data-cf-results owns
               visibility from here. Leaving ours set would keep their list
               hidden through a degrade and blank the screen — the exact
               outcome the else-branch below exists to prevent. */
            root.removeAttribute("data-cf-arrival")
            if (count > 0) {
              root.setAttribute("data-cf-results", "true")
              // Their results carry real lead buttons. Off-screen positioning
              // hid them visually but left 12 stops in the tab order — five of
              // them "I'm interested" — so a keyboard or screen-reader user
              // could submit a genuine lead with no visual cue at all.
              root.querySelectorAll<HTMLElement>(".quotes").forEach((el) => {
                el.setAttribute("inert", "")
                el.setAttribute("aria-hidden", "true")
              })
            } else {
              root.removeAttribute("data-cf-results")
              root.querySelectorAll<HTMLElement>(".quotes").forEach((el) => {
                el.removeAttribute("inert")
                el.removeAttribute("aria-hidden")
              })
            }
          }}
          /* Their submit control is gone for good once quotes land, so the
             only honest edit is a fresh form with the answers carried over.
             Losing five live quotes on a click of the most prominent control
             on the screen — which is what happened before — is worse than a
             reload the visitor asked for. Browser Back from here takes the
             same route, so the two agree. */
          onEdit={reloadWithAnswers}
        />
      )
    }
    return (
      <QuickQuoteWaiting
        quoteCount={quoteCount}
        quotes={arrived}
        panelComplete={panelComplete}
        timedOut={timedOut}
        onRetry={() => {
          setTimedOut(false)
          setSubmitted(false)
          setResortPlayed(false)
          // Per-run, not per-session. This latched: if their signal was
          // unreadable on the first attempt the !done branch set it true with
          // zero rows on screen, and the effect's `panelComplete` guard then
          // early-returned on every later attempt — so a retry wore the first
          // run's verdict and could print "Best price" on a panel that had not
          // finished. The whole point of the flag is that the claim is only
          // made on confirmed evidence.
          setPanelComplete(false)
          // Returning from the timeout lands on the step we were already on, so
          // neither stepIndex nor takeover changes and the focus effect never
          // re-fires — leaving a keyboard or screen-reader user recovering from
          // an error with focus on <body> and no signal they are back on the
          // form. This is exactly what focusNonce exists for; it was wired to
          // the restore path and not to this one.
          setFocusNonce((n) => n + 1)
        }}
      />
    )
  }

  return (
    <div className="cf-wiz">
      <ol className="cf-wiz-steps" aria-label="Progress">
        {steps.map((s, i) => (
          <li
            key={s.id}
            className={i === stepIndex ? "is-current" : i < stepIndex ? "is-done" : undefined}
            aria-current={i === stepIndex ? "step" : undefined}
          >
            <span className="cf-wiz-dot" aria-hidden="true" />
            <span className="cf-wiz-steplabel">{s.title}</span>
          </li>
        ))}
      </ol>

      <p className="cf-visually-hidden" role="status" aria-live="polite">
        Step {stepIndex + 1} of {steps.length}: {step.title}
      </p>

      <div className="cf-wiz-panel">
        <p className="cf-wiz-count">
          Step {stepIndex + 1} of {steps.length}
        </p>
        <h2 className="cf-wiz-heading" tabIndex={-1} ref={headingRef}>
          {step.heading}
        </h2>

        {/* A restore that could not put every car back must say so, the same
            way needsRepick does for a dropped suburb — a visitor who asked
            to edit a two-car quote and silently got a one-car one would only
            find out at submission, or not at all. Shown on step 0 specifically
            — that is where setStepIndex(0) always lands a restore, including a
            multi-car one (the restore effect resyncs lastAdded so the "jump to
            the appended car step" effect does not override it) — so the note
            is seen once, not on every step. */}
        {stepIndex === 0 && carsNotRestored > 0 && (
          <p className="cf-wiz-note" role="status">
            {`We couldn't carry over ${carsNotRestored === 1 ? "one" : carsNotRestored} of your cars — `}
            {/* "Please add it again" names a control that only exists when
                the flag is on. With it off there is no way to add a car, so
                saying so would send someone hunting for a checkbox that is
                not on the page — copy is a factual claim here too. */}
            {multiVehicle
              ? carsNotRestored === 1
                ? "please add it again."
                : "please add them again."
              : "this quote covers one car."}
          </p>
        )}

        {step.fields.map((field) => (
          <div className="cf-wiz-field" key={field}>
            <label htmlFor={`cf-${field}`}>{LABELS[field]}</label>
            {field === "suburb" ? (
              <QuickQuoteSuburbField
                inputId={`cf-${field}`}
                target={
                  (host()?.querySelector(`[name="${FIELD_NAMES.suburb}"]`) as HTMLInputElement) ?? null
                }
                value={answers[field] ?? ""}
                onChange={(v) => {
                  setAnswers((a) => ({ ...a, suburb: v }))
                  // Once they have actually picked, the restore is over. Leaving
                  // this set meant that a visitor who re-picked successfully and
                  // then changed their mind saw "we couldn't carry it over"
                  // again — by then a false reason for a true instruction, and
                  // choose() only reports a non-empty value after FSP's model
                  // has taken it, so this is exactly the point it stops being
                  // true. A failed pick reports "" and correctly keeps the hint.
                  if (v) setSuburbDropped(false)
                }}
                needsRepick={suburbDropped}
              />
            ) : FIELD_KINDS[field].control === "checkbox" ? (
              /* The question is the <label> above; this is its affirmative.
                 Wrapped in its own label so the box and its text are one hit
                 target, and `id` stays on the input so the question's `for`
                 still resolves. */
              <>
                <label className="cf-wiz-check">
                  <input
                    id={`cf-${field}`}
                    type="checkbox"
                    checked={(answers[field] ?? "") !== ""}
                    onChange={(e) => void set(field, e.target.checked ? "yes" : "")}
                  />
                  <span>{CHECK_AFFIRMATIVES[field as keyof typeof CHECK_AFFIRMATIVES]}</span>
                </label>
                {/* A refused tick is otherwise INVISIBLE. Checkboxes never gate
                    Continue — unticked is a real answer — so without this a
                    write FSP rejected would simply snap the box back and let
                    the visitor submit a declaration they believe they made and
                    we did not record. Every other field reports a refusal by
                    leaving the step incomplete; this one has to say so. */}
                {writeFailed.includes(field) && (
                  <p className="cf-wiz-hint cf-wiz-hint-error" role="alert">
                    We couldn&apos;t record that answer — please try again, or
                    continue and mention it when an adviser calls.
                  </p>
                )}
              </>
            ) : FIELD_KINDS[field].control === "number" ? (
              <input
                id={`cf-${field}`}
                type="number"
                inputMode="numeric"
                min={numberKind(field).min}
                max={numberKind(field).max}
                /* Their step, so the spinner arrows move in sensible
                   increments. NOT enforced on submit — see acceptsNumber. */
                step={numberKind(field).step}
                /* The DRAFT, not the answer. These two are deliberately
                   different things — see setNumber. Binding this to `answers`
                   made the field impossible to type into: every prefix of a
                   valid amount ("3", "35", "350"…) is below FSP's minimum, so
                   each keystroke was refused, `answers` was cleared, and React
                   restored the box to empty on every character. */
                value={drafts[field] ?? ""}
                onChange={(e) => void setNumber(field, e.target.value)}
                aria-describedby={`cf-${field}-range`}
                aria-invalid={numberRejected(field)}
              />
            ) : (
              <select
                id={`cf-${field}`}
                value={answers[field] ?? ""}
                /* NOT `disabled`: a disabled control leaves the tab order, so
                   tabbing from the year landed on Model and skipped Make
                   entirely while FSP's cascade was still loading — the visitor
                   never saw the question they were being blocked on.
                   aria-disabled keeps it focusable and announced. */
                aria-disabled={busy === field}
                aria-busy={busy === field}
                onChange={(e) => {
                  if (busy === field) return
                  void set(field, e.target.value)
                }}
              >
                <option value="">
                  {busy === field
                    ? "Loading…"
                    : LABELS[field].endsWith("?")
                      ? "Select an option"
                      : `Choose ${LABELS[field].toLowerCase()}…`}
                </option>
                {(options[field] ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}

              </select>
            )}
            {FIELD_KINDS[field].control === "number" && (
              /* Stated rather than left to be discovered on refusal: the bound
                 is FSP's, and a visitor typing 50 000 of contents gets no quote
                 at all rather than a smaller one.

                 The SAME element carries the error, rather than a second one
                 appearing below it. An amount outside the range has not been
                 recorded, so Continue is already disabled; what the visitor
                 needs is the rule they have broken, which is the sentence
                 already there. Adding a row would also move the button
                 mid-type. */
              <p
                className={
                  numberRejected(field) ? "cf-wiz-hint cf-wiz-hint-error" : "cf-wiz-hint"
                }
                id={`cf-${field}-range`}
                role={numberRejected(field) ? "alert" : undefined}
              >
                {/* An amount their form refused for a reason that is NOT the
                    range needs its own sentence: repeating the bounds at
                    someone who is inside them reads as the page malfunctioning,
                    which — accurately — it is. */}
                {writeFailed.includes(field) && acceptsNumber(field, drafts[field] ?? "")
                  ? "We couldn't record that amount — please try again, or continue and mention it when an adviser calls."
                  : `Between ${formatRands(numberKind(field).min)} and ${formatRands(numberKind(field).max)}`}
              </p>
            )}
            {HINTS[field] && <p className="cf-wiz-hint">{HINTS[field]}</p>}
          </div>
        ))}

        {/*
          BELOW the two questions, not above them — and framed as a shortcut
          rather than a request.

          It was the first field on the first screen: a national ID number
          asked for before a single quote had been shown, on a page run by an
          NCR-registered credit provider. The natural reading of that is a
          credit check, which is a far sharper flinch than generic privacy
          unease and one a pure comparison site never triggers. "(optional)"
          does not neutralise it: the hesitation is paid the moment the field
          is read.

          It earns its place because year-of-birth is an ~80-option dropdown,
          which is genuinely painful on mobile, and most South Africans know
          their ID by heart. So the speed is real — it just must not be the
          opening demand.

          The reassurance is literally true and worth stating: applyIdNumber
          derives birth year and gender and writes ONLY those two into FSP's
          form. The raw number is never put in their field map and does not
          leave the browser at quote stage. Do not add it to FIELD_NAMES
          without changing this copy.
        */}
        {step.id === "you" && (
          <div className="cf-wiz-field cf-wiz-id">
            <label htmlFor="cf-id">
              Know your ID number? <span>Paste it to fill the two answers above</span>
            </label>
            <input
              id="cf-id"
              inputMode="numeric"
              autoComplete="off"
              maxLength={16}
              value={idNumber}
              onChange={(e) => applyIdNumber(e.target.value)}
              placeholder="13 digits — optional"
              aria-describedby="cf-id-privacy"
            />
            <p className="cf-wiz-note" id="cf-id-privacy">
              Used in your browser to fill those two answers. It is not sent with your quote.
            </p>
            <p className="cf-wiz-note" role="status" aria-live="polite">
              {idNote ?? ""}
            </p>
          </div>
        )}

        <p className="cf-visually-hidden" role="status" aria-live="polite">
          {busy ? `Loading ${LABELS[busy].toLowerCase()} options` : ""}
        </p>

        {submitError === "restart" ? (
          <div className="cf-wiz-error" role="alert">
            <p>
              Insurers price a quote once, so this one can&apos;t be re-run with
              different answers. Starting again takes about a minute.
            </p>
            <button
              type="button"
              className="cf-wiz-next"
              /* Carries the answers over. A bare reload here destroyed all
                 twelve of them two steps after the timeout screen promised
                 "Your answers are still here" — the visitor reached this
                 button BY taking that promise. FSP will not re-quote the same
                 submission, which is what "fresh" means; it does not mean the
                 visitor retypes everything. */
              onClick={reloadWithAnswers}
            >
              Start a fresh quote
            </button>
          </div>
        ) : (
          submitError && (
            <p className="cf-wiz-error" role="alert">
              {submitError}
            </p>
          )
        )}

        {/* Named by the forward button while the step is incomplete, so the
            reason is announced with it rather than left to be inferred. */}
        {!stepComplete && blocked && (
          <p className="cf-wiz-blocked" id="cf-wiz-blocked" role="status" aria-live="polite">
            {firstMissing
              ? `${LABELS[firstMissing]} still needs an answer.`
              : "Answer every question on this step to continue."}
          </p>
        )}

        {multiVehicle && showMoreCars && (
          <div className="cf-wiz-morecars" ref={moreCarsRef} />
        )}

        <div className="cf-wiz-actions">
          {stepIndex > 0 && (
            <button
              type="button"
              className="cf-wiz-back"
              /* Delegates to the browser rather than setting state, so our
                 Back and the browser's are one mechanism and cannot drift.
                 popstate above does the actual step change. */
              onClick={() => window.history.back()}
            >
              Back
            </button>
          )}
          {/* NOT `disabled`, for the reason the selects above carry: a disabled
              control leaves the tab order entirely. A keyboard visitor tabbed
              past the last field, found no forward control, reached Back and
              left the wizard — never told one existed or what was holding it.
              aria-disabled keeps it reachable and announced, and activating it
              now says which question is outstanding and moves focus there,
              which is more use than a button that cannot be pressed at all. */}
          <button
            type="button"
            className="cf-wiz-next"
            aria-disabled={!stepComplete}
            aria-describedby={!stepComplete && blocked ? "cf-wiz-blocked" : undefined}
            onClick={() => {
              if (!stepComplete) {
                setBlocked(true)
                if (firstMissing) document.getElementById(`cf-${firstMissing}`)?.focus()
                return
              }
              setBlocked(false)
              if (stepIndex < steps.length - 1) {
                const next = stepIndex + 1
                window.history.pushState({ cfStep: next }, "")
                setStepIndex(next)
              } else submit()
            }}
          >
            {stepIndex < steps.length - 1 ? "Continue" : "Show me my quotes"}
          </button>
        </div>
      </div>
    </div>
  )
}

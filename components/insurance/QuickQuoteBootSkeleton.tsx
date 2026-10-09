import { LABELS, WIZARD_STEPS_BY_VIEW } from "@/lib/insurance/quickquote-bridge"
import type { QuickQuoteView } from "@/lib/insurance/quickquote-config"

/**
 * What the visitor sees while FSP's widget is still loading.
 *
 * NOT a spinner, and not a row of grey pills. The step rail, the step count,
 * the heading and the field labels are OUR content — all of them come from
 * the view's own step list and LABELS, so we know them before FSP answer. Only
 * the option
 * lists need their widget. The form therefore arrives already readable and
 * only its inputs are pending, which is both truer and calmer than a line of
 * text saying "Loading the insurer panel…".
 *
 * It also removes the jerk, and removes it BY CONSTRUCTION rather than with a
 * magic min-height. Measured before this existed: the old boot block was 118px
 * against a 635px wizard, so 517px of content appeared in one frame and the
 * legal section below dropped ~1000px inside the embedding page. This renders
 * the same grid, the same rail and the same number of field rows as step one,
 * so the space is already the right size and nothing moves when the real form
 * takes over.
 *
 * ⚠️ This mirrors the wizard's structure and class names deliberately. If the
 * wizard's first step gains or loses a row and this does not follow, the
 * reservation silently stops matching and the jump returns — smaller, and
 * harder to spot than the one it replaced. Edit the two together.
 */
export function QuickQuoteBootSkeleton({ view }: { view: QuickQuoteView }) {
  const steps = WIZARD_STEPS_BY_VIEW[view]
  const first = steps[0]!

  return (
    <>
      {/* The skeleton is decorative — every word in it is repeated by the real
          form moments later, so announcing it would read the same screen
          twice. Screen readers get this one line instead. */}
      <p className="cf-visually-hidden" role="status" aria-live="polite">
        Loading your quote form
      </p>

      <div className="cf-wiz cf-wiz-skeleton" aria-hidden="true">
        <ol className="cf-wiz-steps">
          {steps.map((s, i) => (
            <li key={s.id} className={i === 0 ? "is-current" : undefined}>
              <span className="cf-wiz-dot" />
              <span className="cf-wiz-steplabel">{s.title}</span>
            </li>
          ))}
        </ol>

        <div className="cf-wiz-panel">
          <p className="cf-wiz-count">Step 1 of {steps.length}</p>
          <h2 className="cf-wiz-heading">{first.heading}</h2>

          {first.fields.map((field, i) => (
            <div className="cf-wiz-field" key={field}>
              {/* Real label, pending control. */}
              <span className="cf-skel-label">{LABELS[field]}</span>
              {/* Staggered so the rows settle in sequence rather than all at
                  once — the same "arriving in order" language the results
                  screen uses as quotes land. Inline because the delay is per
                  index and there are only three. */}
              <span className="cf-skel-input" style={{ animationDelay: `${i * 70}ms` }} />
            </div>
          ))}

          {/* Stands in for the ID-number shortcut (.cf-wiz-id), MEASURED at
              169px against a 74px ordinary field row — that 95px was almost
              exactly the whole remaining jump once the rest was reserved.
              Built from neutral bars rather than the real copy on purpose: that
              block carries the privacy line ("it is not sent with your quote"),
              and briefly showing a stale copy of a privacy claim is a worse
              failure than a small reflow. Re-measure if that block changes. */}
          <div className="cf-wiz-field cf-skel-shortcut">
            <span className="cf-skel-label cf-skel-label-sm" />
            <span className="cf-skel-label cf-skel-label-xs" />
            <span className="cf-skel-input" style={{ animationDelay: "210ms" }} />
            <span className="cf-skel-note" />
          </div>

          <div className="cf-wiz-actions">
            <span className="cf-skel-button" style={{ animationDelay: "280ms" }} />
          </div>
        </div>
      </div>
    </>
  )
}

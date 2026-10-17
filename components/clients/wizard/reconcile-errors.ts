import type { ClientWizardErrors } from "@/lib/validation/client-wizard"

type Key = keyof ClientWizardErrors

/**
 * The step's errors after an edit. A message on screen goes as soon as the
 * edit makes its field valid ("Not a valid ID" while the ID is now valid; the
 * date of birth's "Required" once a valid ID fills it), and a message still
 * true is refreshed to the current one. Typing never ADDS a message: errors
 * appear on Next, as before. A server-only error (e.g. a duplicate ID, which
 * the step's own check cannot see) goes only when its own field is edited.
 */
export function reconcileErrors(
  shown: ClientWizardErrors,
  before: ClientWizardErrors,
  after: ClientWizardErrors,
  changed: readonly string[],
): ClientWizardErrors {
  const next: ClientWizardErrors = {}
  for (const key of Object.keys(shown) as Key[]) {
    if (key in after) {
      Object.assign(next, { [key]: after[key] })
    } else if (!(key in before) && !changed.includes(key)) {
      Object.assign(next, { [key]: shown[key] })
    }
  }
  return next
}

/**
 * Builds the `?step=N` URL for wizard step navigation while preserving every
 * other existing query param (notably `id`, which resume-mode depends on to
 * stay in PATCH mode across Next/Back). Pure function so it can be unit
 * tested without a Next.js router.
 */
export function buildStepUrl(currentSearch: string, step: number): string {
  const params = new URLSearchParams(currentSearch)
  params.set("step", String(step))
  return `?${params.toString()}`
}

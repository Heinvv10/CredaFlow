import type { EligibilityTemplate } from "./types"

export type RenderedTemplate = {
  subject: string | null
  html: string | null
  text: string
}

// Accept the full template (we need subject + body), not just EligibilityTemplate.
// The send path passes the full MessageTemplate; this signature uses a structural
// subset so tests can supply plain objects.
type RenderableTemplate = EligibilityTemplate & {
  subject: string | null
  body: string
  bodyTemplate?: string | null
}

const VAR_RE = /\{\{(\w+)\}\}/g

// substitute() below performs no HTML escaping — callers building an HTML
// bodyTemplate from free-text (e.g. the agent-message compose box) must
// escape the value themselves before it reaches renderTemplate.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (_match, name: string) => {
    if (!(name in vars)) {
      throw new Error(`renderTemplate: missing var "${name}"`)
    }
    return vars[name]
  })
}

export function renderTemplate(
  template: RenderableTemplate,
  vars: Record<string, string>,
): RenderedTemplate {
  const subject = template.subject ? substitute(template.subject, vars) : null
  const text = substitute(template.body, vars)
  // HTML body lives in bodyTemplate (WABA + new email templates) or is derived
  // from text. v1 email path was text+simple-HTML; bodyTemplate is the
  // long-form path. For PR-2 we keep html=null unless bodyTemplate is set.
  const html = template.bodyTemplate ? substitute(template.bodyTemplate, vars) : null
  return { subject, html, text }
}

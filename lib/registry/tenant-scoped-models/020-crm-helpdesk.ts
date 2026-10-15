import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Phase 9 CRM + helpdesk (S1 step 1a). WebhookSignatureFailure is
  // deliberately excluded — its tenantId is nullable (signature failures may
  // predate tenant resolution at the auth seam) so it cannot be enrolled in
  // the auto-injection rewriter.
  "Contact",
  "ContactIdentity",
  "ContactConsent",
  "ContactMerge",
  "Conversation",
  "Message",
] as const)

import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Statement AI (lib/statement-ai): the per-lender switch (SUPER_ADMIN only),
  // an officer's question, and every advisory output the model produced,
  // shown or rejected by the post-check.
  STATEMENT_AI_ENABLED: "STATEMENT_AI_ENABLED",
  STATEMENT_AI_DISABLED: "STATEMENT_AI_DISABLED",
  STATEMENT_AI_QUESTION_ASKED: "STATEMENT_AI_QUESTION_ASKED",
  STATEMENT_AI_OUTPUT_RECORDED: "STATEMENT_AI_OUTPUT_RECORDED",
})

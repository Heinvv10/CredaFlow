import type { ChangeRequest } from "@prisma/client"
import { ChangeRequestError } from "@/lib/maker-checker/errors"
import { createDraft, submit, withdraw } from "@/lib/maker-checker/service"
import type { Actor } from "@/lib/maker-checker/types"
import { LOAN_PRODUCT_KIND, type LoanProductPayload } from "./product-change"

/** A product change, drafted and submitted for a second person's approval in one step. A draft the submit refuses is withdrawn, so nothing is left behind. */
export async function proposeProductChange(tenantId: string, actor: Actor, title: string, payload: LoanProductPayload): Promise<ChangeRequest> {
  const draft = await createDraft({ tenantId, actor, kind: LOAN_PRODUCT_KIND, title, payload })
  try {
    return await submit({ tenantId, actor, id: draft.id })
  } catch (error) {
    if (error instanceof ChangeRequestError) await withdraw({ tenantId, actor, id: draft.id })
    throw error
  }
}

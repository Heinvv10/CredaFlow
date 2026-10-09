// What the wizard tells the operator about a clashing ID number.
//
// Pure and React-free: the decisions worth getting right — stay silent until we
// know, never name another tenant's client, never render "belongs to undefined"
// — are decisions about a payload, not about rendering.

export interface ClientLookupResult {
  exists: boolean
  sameTenant: boolean
  client: { id: string; reference: string; firstName: string; lastName: string } | null
}

export type DuplicateNotice = { show: false } | { show: true; message: string; clientId?: string }

const NOT_SHOWN: DuplicateNotice = { show: false }

/** Said when the ID is taken but the holder is not ours to name. */
const ANONYMOUS = "This ID number is already registered and cannot be used again"

export function duplicateNotice(result: ClientLookupResult | null): DuplicateNotice {
  if (!result || !result.exists) return NOT_SHOWN

  // Both conditions matter. sameTenant guards the cross-tenant leak; the null
  // check guards a malformed payload, which would otherwise interpolate
  // undefined into a sentence shown to staff.
  if (result.sameTenant && result.client) {
    const { firstName, lastName, reference, id } = result.client
    return {
      show: true,
      message: `This ID number already belongs to ${firstName} ${lastName} (${reference})`,
      clientId: id,
    }
  }

  return { show: true, message: ANONYMOUS }
}

type ClientBankDetails = {
  bankName: string | null
  bankAccountNumber: string | null
  bankBranchCode: string | null
  accountType: string | null
}

export type DisbursementBankRequest = {
  bank?: string
  accountNo?: string
  branchCode?: string
  accountType?: string
  bankRef?: string
  overrideProof?: string
}

export type ResolvedDisbursementBankDetails = {
  bank: string
  accountNo: string
  branchCode: string | null
  accountType: string | null
  bankRef: string | null
  overrideUsed: boolean
  overrideProof: string | null
}

export class DisbursementBankDetailsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DisbursementBankDetailsError"
  }
}

function clean(value?: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function sameBankDetails(client: ClientBankDetails, request: DisbursementBankRequest) {
  const requestedBank = clean(request.bank)
  const requestedAccountNo = clean(request.accountNo)
  const requestedBranchCode = clean(request.branchCode)
  const requestedAccountType = clean(request.accountType)

  return (
    (!requestedBank || requestedBank === clean(client.bankName)) &&
    (!requestedAccountNo || requestedAccountNo === clean(client.bankAccountNumber)) &&
    (!requestedBranchCode || requestedBranchCode === clean(client.bankBranchCode)) &&
    (!requestedAccountType || requestedAccountType === clean(client.accountType))
  )
}

export function resolveDisbursementBankDetails({
  client,
  request,
  hasVerifiedBankStatement,
}: {
  client: ClientBankDetails
  request: DisbursementBankRequest
  hasVerifiedBankStatement: boolean
}): ResolvedDisbursementBankDetails {
  const clientBank = clean(client.bankName)
  const clientAccountNo = clean(client.bankAccountNumber)

  if (!clientBank || !clientAccountNo) {
    throw new DisbursementBankDetailsError("Client bank details are incomplete. Update and verify the client record before disbursement.")
  }

  if (!hasVerifiedBankStatement) {
    throw new DisbursementBankDetailsError("A current verified bank statement is required before disbursement.")
  }

  const overrideUsed = !sameBankDetails(client, request)
  const overrideProof = clean(request.overrideProof)

  if (overrideUsed) {
    if (!overrideProof || overrideProof.length < 10) {
      throw new DisbursementBankDetailsError("Bank detail changes require proof of new bank details and a verified bank statement.")
    }

    return {
      bank: clean(request.bank) ?? clientBank,
      accountNo: clean(request.accountNo) ?? clientAccountNo,
      branchCode: clean(request.branchCode) ?? clean(client.bankBranchCode),
      accountType: clean(request.accountType) ?? clean(client.accountType),
      bankRef: clean(request.bankRef),
      overrideUsed: true,
      overrideProof,
    }
  }

  return {
    bank: clientBank,
    accountNo: clientAccountNo,
    branchCode: clean(client.bankBranchCode),
    accountType: clean(client.accountType),
    bankRef: clean(request.bankRef),
    overrideUsed: false,
    overrideProof: null,
  }
}

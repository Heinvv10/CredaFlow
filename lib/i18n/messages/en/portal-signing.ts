/**
 * Portal signing screens: the one-time-code step, the credit agreement page,
 * the debit mandate page and the asset-finance deal signing page. Only generic
 * screen chrome is translated (signature pad, bank form labels, hints, busy and
 * error states, the one-time-code step).
 *
 * Stays English in every language (lib/i18n/.claude.md: never translate credit
 * agreement, PASQ, debit mandate or consent text): the agreement and mandate
 * page titles, the packet/preview labels, the signed-confirmation and
 * download lines, "Consumer Declaration", "Review the exact authority",
 * "Account for debit orders", "Prepare mandate" and the mandate error lines.
 * The declarations, sign buttons and re-sign notice are not in this catalogue at
 * all: they are literals in the components. Errors returned by the API stay as
 * the server wrote them.
 */
export const portalSigning = {
  // One-time code step (components/signing/SigningOtpStep.tsx)
  otpTitle: "Confirm it’s you",
  otpIntro: "We’ll send a one-time code to your contact details on file. Enter it to unlock signing.",
  otpNoChannel: "We have no email address or WhatsApp number on file to send a code to. Please contact us to update your details.",
  otpVerified: "Code verified. You can sign now.",
  otpSendEmail: "Send code by email",
  otpSendWhatsapp: "Send code by WhatsApp",
  otpResendEmail: "Send a new code by email",
  otpResendWhatsapp: "Send a new code by WhatsApp",
  otpSent: "We sent a 6-digit code by {channel} to {destination}. It expires in 5 minutes.",
  channelEmail: "email",
  channelWhatsapp: "WhatsApp",
  otpAria: "One-time code",
  otpVerify: "Verify code",
  otpErrSend: "We could not send a code. Try again.",
  otpErrVerify: "That code could not be verified.",
  otpErrNetwork: "Network error. Try again.",

  // Shared by the agreement and mandate pages
  signing: "Signing...",
  draw: "Draw",
  type: "Type",
  yourSignature: "Your Signature",
  clearSignature: "Clear signature",
  openPdf: "Open PDF",

  // Credit agreement page
  agreementSigned: "Agreement signed",
  agreementMandateRemains: "One step remains: confirm your repayment account and sign the debit mandate.",
  agreementEftNoMandate: "Your repayments are set to EFT. No debit mandate is required.",
  agreementDownloadSigned: "Download signed agreement",
  agreementCopyLater: "Your signed copy will be available to download once we countersign your agreement.",
  setUpRepayment: "Set up repayment",
  viewApplication: "View application",
  agreementTitle: "PASQ + Credit Agreement",
  agreementFor: "{name} — Application {reference}",
  packetLabel: "Signing packet — PASQ first, credit agreement second",
  openPdfNewTab: "Open PDF in a new tab",
  packetFrameTitle: "PASQ and Credit Agreement PDF",
  declarationHeading: "Consumer Declaration",
  drawHint: "Draw your signature below using your mouse or finger",
  signHere: "Sign here",
  typeHint: "Type your full name as it appears on your ID",
  typePlaceholder: "e.g. John Surname",
  dateLine: "Date: {date}",
  signFailedTitle: "Signing failed",
  signFailedBody: "Please try again",

  // Debit mandate page
  mandateSigned: "Debit mandate signed",
  mandateRecorded: "Your repayment authority is recorded against application {reference}.",
  mandateDownload: "Download signed mandate",
  backToApplication: "Back to application",
  mandateTitle: "Repayment bank details",
  mandateSubtitle: "Application {reference} — details must match your verified bank statement.",
  mandateAccountHeading: "Account for debit orders",
  fieldBank: "Bank",
  selectBank: "Select your bank",
  fieldAccountType: "Account type",
  accountCheque: "Cheque / Current",
  accountSavings: "Savings",
  fieldAccountNumber: "Account number",
  fieldBranchCode: "Branch code",
  preparing: "Preparing...",
  prepareMandate: "Prepare mandate",
  reviewAuthority: "Review the exact authority",
  mandateFrameTitle: "Debit mandate preview",
  signatureHeading: "Your signature",
  clear: "Clear",
  typeExactly: "Type your full name exactly: {name}",
  mandateErrPrepare: "Could not prepare the debit mandate.",
  mandateErrSign: "Could not sign the debit mandate.",
  mandateErrNetwork: "The request failed. Check your connection and try again.",

  // Deal document signing page
  dealSigning: "Signing…",
  dealErrSign: "Signing failed; please try again",
  dealErrNetwork: "We could not reach the server; check your connection and try again",
} as const

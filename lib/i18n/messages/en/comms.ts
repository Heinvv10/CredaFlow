/**
 * Borrower emails and WhatsApp free text, in the client's preferredLanguage
 * (lib/i18n/comms.ts). The email strings are HTML: entities and the few
 * inline tags are part of the message, and values arrive already escaped.
 * English must render byte-identical to the pre-catalogue templates
 * (lib/email/templates/english-pinned.test.ts); the wa_* English must equal
 * WA_TEMPLATES (comms.test.ts), which English sends still use.
 *
 * Stays English in every language, so not here: the application-declined
 * email (NCA decline disclosure and rights), everything Section 129, the
 * payment-due reminder cron and collections reminders, and the regulatory
 * footer line of every email.
 */
export const comms = {
  dear: "Dear <strong>{name}</strong>,",
  labelReference: "Reference Number",
  labelProduct: "Product",
  labelAppliedAmount: "Applied Amount",
  labelApprovedAmount: "Approved Amount",
  labelStatus: "Status",
  labelLoanReference: "Loan Reference",
  labelPaymentAmount: "Payment Amount",
  labelOutstanding: "Outstanding Balance",
  questions: "Questions?",
  anyQuestionsContact: "If you have any questions, please contact us at {link}",
  anyQueriesContact: "For any queries, contact us at {link}",
  headerSubmitted: "Loan Application Received",
  submittedHeading: "We&rsquo;ve received your application",
  submittedThanks: "Thank you for applying for a loan with {brand}. We have received your application and our team will review it shortly.",
  statusSubmitted: "Submitted",
  trackMyApplication: "Track my application",
  trackWithLink: "Track the status of your application at any time in your client portal:",
  trackWithoutLink: "You can track the status of your application at any time by logging into your client portal.",
  submittedDecisionTime: "We will notify you once a decision has been made. This typically takes 1–2 business days.",
  headerApproved: "Loan Application Approved",
  approvedHeading: "Your loan has been approved",
  approvedBody: "Congratulations! Your loan application has been {approved}. Please review and sign your credit agreement to proceed with disbursement.",
  approvedWord: "approved",
  statusApproved: "Approved",
  actionSignTitle: "Action Required: Sign Your Credit Agreement",
  actionSignBody: "Your credit agreement is ready to be signed. You must sign the agreement before funds can be disbursed.",
  reviewSignCta: "Review &amp; Sign Agreement",
  notYouContact: "If you did not apply for this loan or believe this email was sent in error, please contact us immediately at {link}",
  headerReceived: "Payment Received",
  receivedHeading: "Payment received &mdash; thank you",
  receivedBody: "We have received your payment. Thank you for keeping your account up to date.",
  receivedGoodStanding: "Your account remains in good standing. Log in to your portal to view your updated repayment schedule.",
  headerDisbursed: "Loan Disbursement",
  disbursedHeading: "Your loan has been disbursed",
  disbursedBody: "Your loan (<strong>{ref}</strong>) has been disbursed. Funds will reflect in your account within 1&ndash;2 business days. Please refer to your repayment schedule for payment dates.",
  headerOverdue: "Payment Overdue",
  overdueHeading: "Payment overdue notice",
  overdueBodyDays: "Your loan payment is overdue by <strong>{n} days</strong>. Please make payment as soon as possible to avoid additional fees and to protect your credit record.",
  overdueBody: "Your loan payment is overdue. Please make payment as soon as possible to avoid additional fees and to protect your credit record.",
  overdueQuoteRef: "Please quote your loan reference <strong>{ref}</strong> on your payment so we can allocate it to your account.",
  subjSubmitted: "Your Loan Application Has Been Received",
  textSubmitted: "Dear {name}, your application ({ref}) has been received. We will notify you of the outcome within 1–2 business days.",
  subjApproved: "Your Loan Application Has Been Approved",
  textApproved: "Dear {name}, your application ({ref}) has been approved. Log in to your portal to sign your credit agreement.",
  subjReceived: "Payment Received — Thank You",
  textReceived: "Dear {name}, we received your payment. Your outstanding balance is {balance}.",
  subjDisbursed: "Loan Disbursement Confirmation",
  textDisbursed: "Dear {name}, your loan ({ref}) has been disbursed. Funds will reflect within 1–2 business days.",
  subjOverdue: "Payment Overdue Notice",
  textOverdueDaysRef: "Dear {name}, your loan payment is overdue by {n} days. Please make payment immediately, quoting reference {ref}.",
  textOverdueDays: "Dear {name}, your loan payment is overdue by {n} days. Please make payment immediately.",
  textOverdueRef: "Dear {name}, your loan payment is overdue. Please make payment immediately, quoting reference {ref}.",
  textOverdue: "Dear {name}, your loan payment is overdue. Please make payment immediately.",
  wa_application_submitted: "Hi {name} 👋\n\nYour loan application *{ref}* for *{amount}* has been received.\n\nWe'll review it within 24 hours and be in touch. Thank you for choosing {brand}.",
  wa_application_approved: "Good news {name}! 🎉\n\nYour loan application for *{amount}* has been *approved*.\n\nRef: {ref}\n\nWe'll be in touch shortly to finalise the agreement.",
  wa_loan_disbursed: "Hi {name} ✅\n\nYour loan of *{amount}* has been paid to your account.\n\nYour first payment is due on *{dueDate}*. You can view your repayment schedule on the client portal.",
  wa_payment_received: "Hi {name} ✅\n\nWe've received your payment of *{amount}*.\n\nOutstanding balance: *{balance}*. Thank you!",
  wa_payment_overdue_1d: "Hi {name},\n\n⚠️ Your payment of *{amount}* on loan *{ref}* was due yesterday.\n\nPlease pay urgently to avoid additional charges. Contact us immediately if you are experiencing difficulty.",
  wa_payment_overdue_7d: "URGENT - {name}\n\nLoan *{ref}* is *7 days overdue*. Outstanding: *{amount}*.\n\nPlease contact us immediately: {phone}\n\nFurther action will be taken if payment is not received.",
} as const

// lib/manual/curriculum.ts
// Single source of truth for the Admin Academy — imported by the /learn pages.
// Pure data + pure helpers only: no server imports, no "@/" aliases.

export type LessonStep = {
  /** One-line caption shown in the video lower-third and on the lesson page. */
  caption: string
  /** Dashboard route captured for this step (drives the capture script). */
  liveRoute: string
}

export type Lesson = {
  slug: string
  title: string
  summary: string
  /** Minimum role the REAL flow needs (informational label, not the page gate). */
  requiredRole: string
  /** "Open the live screen" deep link. */
  liveRoute: string
  /** Compliance / gotcha notes surfaced on the lesson page. */
  keyRules: string[]
  steps: LessonStep[]
}

export type ManualModule = {
  slug: string
  title: string
  description: string
  lessons: Lesson[]
}

export const curriculum: ManualModule[] = [
  {
    slug: "getting-started",
    title: "Getting Started",
    description: "Sign in securely and learn to read the dashboard before touching a file.",
    lessons: [
      {
        slug: "sign-in-2fa",
        title: "Sign in with TOTP 2FA",
        summary: "Log in and complete two-factor authentication — mandatory for all staff.",
        requiredRole: "READONLY",
        liveRoute: "/dashboard",
        keyRules: ["2FA is mandatory for staff. Never share TOTP codes.", "Enrol your authenticator at /settings/security."],
        steps: [
          { caption: "Open the staff login page", liveRoute: "/login" },
          { caption: "Enter your email and password", liveRoute: "/login" },
          { caption: "Enter the 6-digit code from your authenticator app", liveRoute: "/login" },
          { caption: "You land on the Executive Dashboard", liveRoute: "/dashboard" },
        ],
      },
      {
        slug: "dashboard-triage",
        title: "Executive dashboard & daily triage",
        summary: "Use the dashboard first every morning to prioritise the day's highest-risk work.",
        requiredRole: "READONLY",
        liveRoute: "/dashboard",
        keyRules: ["Dashboard totals are signals — always drill into the underlying record before acting."],
        steps: [
          { caption: "Read the portfolio health tiles", liveRoute: "/dashboard" },
          { caption: "Check pending application and collections badges", liveRoute: "/dashboard" },
          { caption: "Open the highest-risk queue first", liveRoute: "/applications" },
        ],
      },
    ],
  },
  {
    slug: "origination",
    title: "Origination",
    description: "Turn a client request into an auditable, NCA-compliant application.",
    lessons: [
      {
        slug: "intake-to-application",
        title: "Public/portal intake to admin application",
        summary: "Follow a submission from the public site or portal into the admin applications queue.",
        requiredRole: "CREDIT_OFFICER",
        liveRoute: "/applications",
        keyRules: ["Every status change is audited.", "Confirm client identity and product before starting review."],
        steps: [
          { caption: "A client submits via the public apply form", liveRoute: "/applications" },
          { caption: "The application appears in the queue as SUBMITTED", liveRoute: "/applications" },
          { caption: "Open the application to begin review", liveRoute: "/applications" },
        ],
      },
      {
        slug: "application-review-affordability",
        title: "Application review & affordability",
        summary: "Capture affordability and complete reckless-credit / PASQ checks.",
        requiredRole: "CREDIT_OFFICER",
        liveRoute: "/applications",
        keyRules: ["Do not skip NCA affordability checks.", "Bureau override needs a permitted role + recorded reason."],
        steps: [
          { caption: "Start review and confirm the product", liveRoute: "/applications" },
          { caption: "Capture income, expenses and affordability", liveRoute: "/applications" },
          { caption: "Review the affordability result", liveRoute: "/applications" },
        ],
      },
      {
        slug: "client-record-kyc",
        title: "Client record & KYC",
        summary: "Maintain one reliable customer profile across lending, insurance and portal.",
        requiredRole: "CREDIT_OFFICER",
        liveRoute: "/clients",
        keyRules: ["Check for duplicates by ID, email and phone before creating a client.", "Document viewing is POPIA-logged."],
        steps: [
          { caption: "Open the client record", liveRoute: "/clients" },
          { caption: "Review KYC, employment and banking tabs", liveRoute: "/clients" },
          { caption: "Check consent and POPIA preferences", liveRoute: "/clients" },
        ],
      },
      {
        slug: "documents-ocr-compliance",
        title: "Documents, OCR & compliance evidence",
        summary: "See how uploaded documents feed KYC, affordability and NCA evidence.",
        requiredRole: "CREDIT_OFFICER",
        liveRoute: "/clients",
        keyRules: ["Treat OCR extraction as evidence, not blind truth.", "Document access writes a DocumentAccessLog row (POPIA)."],
        steps: [
          { caption: "Open an uploaded document on the client record", liveRoute: "/clients" },
          { caption: "Review the extracted fields", liveRoute: "/clients" },
          { caption: "Confirm the document against the checklist", liveRoute: "/clients" },
        ],
      },
    ],
  },
  {
    slug: "decision-disbursement",
    title: "Decision & Disbursement",
    description: "From approved application to signed agreement and disbursed funds.",
    lessons: [
      {
        slug: "nca-checks-bureau",
        title: "NCA checks & credit bureau",
        summary: "Complete the credit decision, including an s.81 override when the bureau is unavailable.",
        requiredRole: "LOAN_ADMIN",
        liveRoute: "/applications",
        keyRules: ["Never paraphrase NCA-mandated language.", "Bureau override requires a recorded reason and evidence."],
        steps: [
          { caption: "Review the bureau result", liveRoute: "/applications" },
          { caption: "Apply an s.81 override with a reason if required", liveRoute: "/applications" },
          { caption: "Approve or decline with a clear reason", liveRoute: "/applications" },
        ],
      },
      {
        slug: "agreement-signing",
        title: "Agreement & signing",
        summary: "Generate the credit agreement and debit mandate after a complete decision.",
        requiredRole: "LOAN_ADMIN",
        liveRoute: "/applications",
        keyRules: ["Generate the agreement only after decision requirements are complete.", "Agreement PDF text is legally exact — do not edit."],
        steps: [
          { caption: "Generate the agreement after approval", liveRoute: "/applications" },
          { caption: "The client signs from the portal", liveRoute: "/applications" },
          { caption: "The signed agreement links to the application", liveRoute: "/applications" },
        ],
      },
      {
        slug: "disbursement",
        title: "Disbursement",
        summary: "Move an approved, signed application to a live loan account.",
        requiredRole: "LOAN_ADMIN",
        liveRoute: "/disbursements",
        keyRules: ["Disbursement is audited and creates the loan schedule."],
        steps: [
          { caption: "Open the disbursements queue", liveRoute: "/disbursements" },
          { caption: "Confirm banking details and disburse", liveRoute: "/disbursements" },
          { caption: "The loan account and schedule are created", liveRoute: "/loans" },
        ],
      },
    ],
  },
  {
    slug: "servicing",
    title: "Servicing",
    description: "Run the loan: schedule, repayments, allocations and reversals.",
    lessons: [
      {
        slug: "loan-account-schedule",
        title: "Loan account & repayment schedule",
        summary: "Read a loan account, its schedule and current balances.",
        requiredRole: "READONLY",
        liveRoute: "/loans",
        keyRules: ["Balances come from the schedule + payment allocations."],
        steps: [
          { caption: "Open an active loan", liveRoute: "/loans" },
          { caption: "Read the repayment schedule", liveRoute: "/loans" },
          { caption: "Check the current balance and arrears", liveRoute: "/loans" },
        ],
      },
      {
        slug: "payments-allocation-reversals",
        title: "Payments: capture, allocation & reversals",
        summary: "Capture a receipt, see how it allocates, and reverse safely.",
        requiredRole: "LOAN_ADMIN",
        liveRoute: "/payments",
        keyRules: ["Reversals are audited and must not clobber loan status (audit F-fix).", "Allocation order is system-driven."],
        steps: [
          { caption: "Capture a payment against a loan", liveRoute: "/payments" },
          { caption: "See the allocation reduce arrears then principal", liveRoute: "/payments" },
          { caption: "Reverse a payment with a reason", liveRoute: "/payments" },
        ],
      },
    ],
  },
  {
    slug: "collections",
    title: "Collections",
    description: "Work arrears from reminder to Section 129 and attorney referral.",
    lessons: [
      {
        slug: "arrears-monitoring",
        title: "Arrears monitoring",
        summary: "Find and prioritise loans in arrears.",
        requiredRole: "COLLECTIONS_OFFICER",
        liveRoute: "/collections",
        keyRules: ["Only ACTIVE/DEFAULTED loans actually in arrears count toward the queue."],
        steps: [
          { caption: "Open the collections queue", liveRoute: "/collections" },
          { caption: "Sort by days in arrears", liveRoute: "/collections" },
          { caption: "Open a delinquent loan", liveRoute: "/collections" },
        ],
      },
      {
        slug: "arrangements",
        title: "Payment arrangements",
        summary: "Agree and record a payment arrangement with a client.",
        requiredRole: "COLLECTIONS_OFFICER",
        liveRoute: "/collections",
        keyRules: ["Arrangements are audited and tracked against the loan."],
        steps: [
          { caption: "Open the arrangement panel on a loan", liveRoute: "/collections" },
          { caption: "Capture the arrangement terms", liveRoute: "/collections" },
          { caption: "Save and confirm the arrangement", liveRoute: "/collections" },
        ],
      },
      {
        slug: "section-129-attorney",
        title: "Section 129 notice & attorney referral",
        summary: "Generate the S129 notice and escalate to an attorney.",
        requiredRole: "COLLECTIONS_OFFICER",
        liveRoute: "/collections",
        keyRules: ["Section 129 text is legally exact — never paraphrase.", "Escalation is a controlled, audited action."],
        steps: [
          { caption: "Confirm the loan qualifies for S129", liveRoute: "/collections" },
          { caption: "Generate the Section 129 notice", liveRoute: "/collections" },
          { caption: "Refer to an attorney with the reason recorded", liveRoute: "/collections" },
        ],
      },
    ],
  },
  {
    slug: "growth-comms",
    title: "Growth & Comms",
    description: "Leads, opportunities, contacts and the agent inbox.",
    lessons: [
      {
        slug: "leads-opportunities",
        title: "Leads & opportunities",
        summary: "Work the CRM pipeline and cross-sell opportunities.",
        requiredRole: "READONLY",
        liveRoute: "/crm/leads",
        keyRules: ["CRM widgets depend on the tenant's CRM feature flag."],
        steps: [
          { caption: "Open the CRM leads pipeline", liveRoute: "/crm/leads" },
          { caption: "Review an opportunity", liveRoute: "/crm/opportunities" },
          { caption: "Update the lead status", liveRoute: "/crm/leads" },
        ],
      },
      {
        slug: "contacts-inbox",
        title: "Contacts & the comms hub inbox",
        summary: "Use the unified contact directory and the agent inbox.",
        requiredRole: "READONLY",
        liveRoute: "/inbox",
        keyRules: ["Messaging a client requires consent and is audited.", "WhatsApp channel availability depends on tenant settings."],
        steps: [
          { caption: "Open the contacts directory", liveRoute: "/contacts" },
          { caption: "Open the agent inbox", liveRoute: "/inbox" },
          { caption: "Read a conversation thread", liveRoute: "/inbox" },
        ],
      },
    ],
  },
  {
    slug: "cover-compliance",
    title: "Cover & Compliance",
    description: "Insurance, complaints, DSAR and the audit trail.",
    lessons: [
      {
        slug: "insurance-claims",
        title: "Insurance & claims",
        summary: "Read insurance policies and track a claim.",
        requiredRole: "INSURANCE_OFFICER",
        liveRoute: "/insurance",
        keyRules: ["Insurance premium/sum-assured are stored in RANDS (loan fields are cents)."],
        steps: [
          { caption: "Open an insurance policy", liveRoute: "/insurance" },
          { caption: "Open the claims queue", liveRoute: "/insurance/claims" },
          { caption: "Track a claim's status", liveRoute: "/insurance/claims" },
        ],
      },
      {
        slug: "complaints-tcf",
        title: "Complaints (TCF)",
        summary: "Log and track a complaint in the TCF register.",
        requiredRole: "READONLY",
        liveRoute: "/compliance/complaints",
        keyRules: ["When in doubt, log. The complaints register is a compliance obligation."],
        steps: [
          { caption: "Open the complaints register", liveRoute: "/compliance/complaints" },
          { caption: "Log a new complaint", liveRoute: "/compliance/complaints" },
          { caption: "Track the complaint to resolution", liveRoute: "/compliance/complaints" },
        ],
      },
      {
        slug: "dsar-audit",
        title: "DSAR & audit trail",
        summary: "Handle a POPIA data subject request and read the audit trail.",
        requiredRole: "LOAN_ADMIN",
        liveRoute: "/compliance/dsar",
        keyRules: ["DSAR is a POPIA obligation.", "The audit log records every state-changing staff action."],
        steps: [
          { caption: "Open the DSAR queue", liveRoute: "/compliance/dsar" },
          { caption: "Process a data subject request", liveRoute: "/compliance/dsar" },
          { caption: "Verify the action in the audit log", liveRoute: "/settings/audit-log" },
        ],
      },
    ],
  },
  {
    slug: "administration",
    title: "Administration",
    description: "Users, products, comms settings and credit policy.",
    lessons: [
      {
        slug: "users-roles",
        title: "Users & roles",
        summary: "Create staff users and assign roles and branches.",
        requiredRole: "ADMIN",
        liveRoute: "/settings/users",
        keyRules: ["Role controls access. 2FA enrolment is mandatory."],
        steps: [
          { caption: "Open user management", liveRoute: "/settings/users" },
          { caption: "Create a user and assign a role", liveRoute: "/settings/users" },
          { caption: "Confirm branch and access", liveRoute: "/settings/users" },
        ],
      },
      {
        slug: "products-pricing",
        title: "Products & pricing",
        summary: "Configure loan products, amounts, terms and fees.",
        requiredRole: "ADMIN",
        liveRoute: "/settings/products",
        keyRules: ["Amounts are stored in cents.", "Apply-flow tiering is separate from product ranges."],
        steps: [
          { caption: "Open the products list", liveRoute: "/settings/products" },
          { caption: "Edit a product's amount and term ranges", liveRoute: "/settings/products" },
          { caption: "Save and verify the change", liveRoute: "/settings/products" },
        ],
      },
      {
        slug: "comms-credit-settings",
        title: "Comms & credit-policy settings",
        summary: "Configure email/WhatsApp comms and the credit policy thresholds.",
        requiredRole: "ADMIN",
        liveRoute: "/settings/email",
        keyRules: ["Credit policy (bureauMinScore, adverse block, NDI buffer) lives on TenantConfig."],
        steps: [
          { caption: "Open email/comms settings", liveRoute: "/settings/email" },
          { caption: "Review WhatsApp settings", liveRoute: "/settings/whatsapp" },
          { caption: "Set the credit-policy thresholds", liveRoute: "/settings" },
        ],
      },
    ],
  },
]

export function allLessons(): Lesson[] {
  return curriculum.flatMap((m) => m.lessons)
}

export function findLesson(slug: string): Lesson | undefined {
  return allLessons().find((l) => l.slug === slug)
}

export function lessonAssets(slug: string): { video: string; poster: string } {
  return {
    video: `/admin-manual/videos/${slug}.mp4`,
    poster: `/admin-manual/screenshots/${slug}.png`,
  }
}

export function totalLessonCount(): number {
  return allLessons().length
}

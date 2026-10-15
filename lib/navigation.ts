import { waHref } from "@/lib/support/whatsapp-intents"
import {
  Activity,
  AlertTriangle,
  Banknote,
  BarChart3,
  Percent,
  Bell,
  BriefcaseBusiness,
  Building2,
  Factory,
  Contact,
  CreditCard,
  FileCheck,
  FileText,
  Gauge,
  GraduationCap,
  HelpCircle,
  History,
  Home,
  Inbox,
  KeyRound,
  Landmark,
  Lock,
  MessageSquare,
  Scale,
  Shield,
  ShieldCheck,
  Target,
  Truck,
  Upload,
  Users,
  Wallet,
} from "lucide-react"
import type { ElementType } from "react"
import type { UserRole } from "@/lib/permissions"

// One definition, imported by AppShell and AppSidebar. It used to be spelled
// out separately in all three files, so adding a badge meant editing three
// unions and the compiler only caught it on the third.
/**
 * Every badge key, as a value. The union below is derived from it rather than
 * written twice, so a test can iterate the real list instead of a hand-copied
 * one that silently stops covering a key somebody adds.
 */
export const STAFF_BADGE_KEYS = [
  "applications",
  "collections",
  "opportunities",
  "leads",
  "inbox",
] as const

export type StaffBadgeKey = (typeof STAFF_BADGE_KEYS)[number]

/**
 * What each badge actually counts, as singular/plural nouns.
 *
 * A bare number invites the reader's own definition, and on a shared inbox the
 * obvious one is wrong: the inbox badge counts conversations where a CUSTOMER
 * is waiting on a reply, not unread messages (every inbound message on this
 * system is marked read the moment anyone opens the thread, so an unread count
 * decays to zero and stays there — see lib/inbox/unanswered.ts). The number was
 * right and read as something else, which is the failure this names away.
 */
const BADGE_NOUNS: Record<StaffBadgeKey, { one: string; many: string }> = {
  applications: {
    one: "application awaiting a decision",
    many: "applications awaiting a decision",
  },
  collections: { one: "loan in arrears", many: "loans in arrears" },
  opportunities: {
    one: "open cross-sell opportunity",
    many: "open cross-sell opportunities",
  },
  leads: { one: "new lead awaiting contact", many: "new leads awaiting contact" },
  inbox: {
    one: "conversation awaiting a reply",
    many: "conversations awaiting a reply",
  },
}

/**
 * Accessible label for a sidebar badge — "3 conversations awaiting a reply".
 *
 * Takes the UNTRUNCATED count on purpose: the badge renders "99+", which is
 * not a number anyone can act on.
 */
export function badgeDescription(key: StaffBadgeKey, count: number): string {
  const noun = BADGE_NOUNS[key]
  return `${count} ${count === 1 ? noun.one : noun.many}`
}

export type NavItem = {
  href: string
  label: string
  icon: ElementType
  badgeKey?: StaffBadgeKey
  external?: boolean
  minRole?: UserRole
}

export type NavGroup = {
  label: string
  items: NavItem[]
  feature?: "crm" | "ims" | "bureauSubmission" | "assetFinance"
}

export const staffNavigation: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Executive Dashboard", icon: Gauge },
      { href: "/reports", label: "Reports", icon: BarChart3 },
      { href: "/reports/board-pack", label: "Board Pack", icon: BarChart3 },
      { href: "/learn", label: "Academy", icon: GraduationCap },
    ],
  },
  {
    label: "Comms",
    items: [
      { href: "/inbox", label: "Inbox", icon: Inbox, badgeKey: "inbox" },
    ],
  },
  {
    label: "Origination",
    items: [
      { href: "/applications", label: "Applications", icon: FileText, badgeKey: "applications" },
      { href: "/clients", label: "Clients", icon: Users },
      { href: "/disbursements", label: "Disbursements", icon: Banknote },
    ],
  },
  {
    label: "Servicing",
    items: [
      { href: "/loans", label: "Active Loans", icon: Wallet },
      { href: "/payments", label: "Payments", icon: CreditCard },
      { href: "/payments/bank-reconciliation", label: "Bank Reconciliation", icon: Landmark, minRole: "CREDIT_OFFICER" },
      { href: "/collections", label: "Collections", icon: AlertTriangle, badgeKey: "collections" },
    ],
  },
  {
    // Asset finance (docs/asset-finance/DESIGN.md D9): instalment sale and
    // leasing for business entities. Every page under /asset-finance also
    // redirects when the flag is off (app/(dashboard)/asset-finance/layout.tsx).
    label: "Asset Finance",
    feature: "assetFinance",
    items: [
      { href: "/asset-finance/entities", label: "Entities", icon: Building2 },
      { href: "/asset-finance/deals", label: "Deals", icon: FileText },
      { href: "/asset-finance/assets", label: "Assets", icon: Truck },
      { href: "/asset-finance/suppliers", label: "Suppliers", icon: Factory },
      { href: "/asset-finance/reference-rates", label: "Reference rates", icon: Percent },
    ],
  },
  {
    label: "Growth",
    feature: "crm",
    items: [
      { href: "/crm", label: "CRM Dashboard", icon: Target },
      { href: "/crm/leads", label: "Leads", icon: Users, badgeKey: "leads" },
      { href: "/crm/agent-hub", label: "Agent Hub", icon: Target },
      { href: "/contacts", label: "Contacts", icon: Contact },
      { href: "/crm/opportunities", label: "Opportunities", icon: BriefcaseBusiness, badgeKey: "opportunities" },
    ],
  },
  {
    label: "Cover",
    feature: "ims",
    items: [
      { href: "/insurance", label: "Insurance", icon: Shield },
      { href: "/insurance/claims", label: "Claims", icon: FileCheck },
    ],
  },
  {
    // Deliberately NOT gated on `ims`. These are the NCA and POPIA duties of a
    // registered credit provider — the NCR quarterly return, Section 129
    // notices, DSAR and complaints. They were bundled into the insurance
    // group, so switching the insurance module off hid a lender's statutory
    // obligations and made /compliance redirect to /dashboard.
    label: "Compliance",
    items: [
      { href: "/compliance", label: "Compliance", icon: Scale },
      { href: "/compliance/ncr-return", label: "NCR Return", icon: Landmark },
      { href: "/compliance/complaints", label: "Complaints", icon: MessageSquare },
      { href: "/compliance/dsar", label: "DSAR", icon: Lock },
      { href: "/compliance/screening", label: "Screening", icon: ShieldCheck, minRole: "BRANCH_MANAGER" },
      { href: "/compliance/fic", label: "FIC Act", icon: Landmark, minRole: "ADMIN" },
    ],
  },
  {
    // Bureau DATA SUBMISSION (lib/bureau-submission), not the credit enquiry.
    // Its own group because a nav group is what a tenant flag can switch.
    label: "Credit Bureau",
    feature: "bureauSubmission",
    items: [
      { href: "/compliance/bureau-submissions", label: "Bureau Submissions", icon: FileCheck, minRole: "LOAN_ADMIN" },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/settings", label: "Settings", icon: Building2 },
      // No minRole: TOTP 2FA is on by default per lender (see CLAUDE.md), so the
      // enrolment page must be reachable by all roles (ADM-02).
      { href: "/settings/security", label: "Security & 2FA", icon: KeyRound },
      { href: "/settings/security-policy", label: "Security & KYC policy", icon: ShieldCheck, minRole: "ADMIN" },
      // The page requires ADMIN (app/(dashboard)/settings/support-access/page.tsx).
      { href: "/settings/support-access", label: "Support access", icon: ShieldCheck, minRole: "ADMIN" },
      { href: "/settings/users", label: "Users", icon: Users, minRole: "BRANCH_MANAGER" },
      { href: "/settings/audit-log", label: "Audit Trail", icon: History, minRole: "LOAN_ADMIN" },
      { href: "/settings/login-log", label: "Login Activity", icon: Activity, minRole: "LOAN_ADMIN" },
    ],
  },
]

/**
 * `whatsappE164` is the lender's `identity.publicWhatsappE164`; without one the
 * Support item is omitted. `business` adds the asset-finance business page for
 * a client who may act for an entity (lib/asset-finance/portal-access.ts).
 */
export function buildPortalNavigation(whatsappE164: string | null, opts: { business?: boolean } = {}): NavItem[] {
  return [
    { href: "/portal", label: "Overview", icon: Home },
    ...(opts.business ? [{ href: "/portal/business", label: "Business", icon: Building2 }] : []),
    { href: "/portal/applications", label: "Applications", icon: FileText },
    { href: "/portal/apply", label: "Apply", icon: Upload },
    { href: "/portal/loans", label: "Loans", icon: Wallet },
    { href: "/portal/insurance", label: "Insurance", icon: Shield },
    { href: "/portal/documents", label: "Documents", icon: FileCheck },
    { href: "/portal/statement", label: "Statements", icon: BarChart3 },
    { href: "/portal/payment", label: "Payment", icon: CreditCard },
    { href: "/portal/notifications", label: "Notifications", icon: Bell },
    { href: "/portal/profile", label: "Profile", icon: Users },
    ...(whatsappE164
      ? [{
          href: waHref(whatsappE164, "Hi, I need help with my loan account"),
          label: "Support",
          icon: HelpCircle,
          external: true,
        }]
      : []),
  ]
}

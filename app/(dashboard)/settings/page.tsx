import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { formatZAR } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

async function getLoanProducts() {
  const tenantId = await getStaffTenantId()
  return prisma.loanProduct.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
  })
}

async function getUsers() {
  const tenantId = await getStaffTenantId()
  return prisma.user.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      createdAt: true,
    },
  })
}

export default async function SettingsPage() {
  const [products, users] = await Promise.all([getLoanProducts(), getUsers()])

  return (
    <>
      <Header title="Settings" subtitle="System configuration" />
      <div className="p-4 lg:p-8 space-y-8">
        {/* Quick links */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <a href="/settings/email"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">📧 Email Setup</p>
              <p className="text-xs text-gray-500 mt-0.5">Configure MS Graph or IMAP/SMTP for sending and tracking</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </a>
          <a href="/settings/users"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">👥 Manage Users</p>
              <p className="text-xs text-gray-500 mt-0.5">Invite, edit, and manage user accounts and roles</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </a>
          <a href="/settings/automation"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">⚡ Automation</p>
              <p className="text-xs text-gray-500 mt-0.5">Rules engine — configure automated WhatsApp, tasks, and stages</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </a>
          <Link href="/settings/attorneys"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-purple-100 hover:border-purple-400 hover:bg-purple-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-purple-800">⚖ Attorney Firms</p>
              <p className="text-xs text-gray-500 mt-0.5">Register of law firms used for collections referrals</p>
            </div>
            <span className="text-purple-500 text-xl">→</span>
          </Link>
          <a href="/settings/comms"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">💬 Comms Hub — inbox</p>
              <p className="text-xs text-gray-500 mt-0.5">Out-of-hours auto-reply, business hours, canned replies, and the agent roster</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </a>
          <Link href="/settings/identity"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🏛 Lender Identity</p>
              <p className="text-xs text-gray-500 mt-0.5">Legal name, NCR/FSP/company numbers and contact details on documents</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/credit-policy"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🛡 Credit Policy</p>
              <p className="text-xs text-gray-500 mt-0.5">Bureau score gate, adverse-info block, and affordability buffer</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/documents"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">📄 Document Templates</p>
              <p className="text-xs text-gray-500 mt-0.5">NCA system documents and custom letter templates</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/security"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🔐 Security & 2FA</p>
              <p className="text-xs text-gray-500 mt-0.5">Enable two-factor authentication for your account</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/security-policy"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🛡 Security & KYC policy</p>
              <p className="text-xs text-gray-500 mt-0.5">Whether staff must use two-factor authentication (Super Admin changes it)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/bank-sync"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🏧 Bank Statement Import</p>
              <p className="text-xs text-gray-500 mt-0.5">Switch bank-statement CSV import and reconciliation on or off (ADMIN, 2FA)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/branches"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🏢 Branches</p>
              <p className="text-xs text-gray-500 mt-0.5">Branch locations, managers, territories (ADMIN)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          {/*
            The IMS module switch. Linked here deliberately: it withdraws the
            insurance API surface, and a control reachable only by typing its
            URL is not much of a control when it is needed urgently. The description
            names only what the switch actually covers — insurer and insurance
            product setup below stay reachable either way, because live credit
            life reads those records.
          */}
          <Link href="/settings/insurance"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🛡️ Insurance Module</p>
              <p className="text-xs text-gray-500 mt-0.5">Switch the Insurance and Compliance sections on or off, and check product readiness (ADMIN)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/asset-finance"
            className="flex items-center justify-between p-5 rounded-xl shadow-sm border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] hover:border-[var(--cf-brand)] hover:bg-[var(--cf-surface-hover)] transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[var(--cf-text)] group-hover:text-[var(--cf-brand)]">🚜 Asset Finance</p>
              <p className="text-xs text-[var(--cf-text-muted)] mt-0.5">Switch the module on or off, payout approval threshold and VAT details (ADMIN)</p>
            </div>
            <span className="text-[var(--cf-brand)] text-xl">→</span>
          </Link>
          <Link href="/settings/api"
            className="flex items-center justify-between p-5 rounded-xl shadow-sm border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] hover:border-[var(--cf-brand)] hover:bg-[var(--cf-surface-hover)] transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[var(--cf-text)] group-hover:text-[var(--cf-brand)]">🔑 API & webhooks</p>
              <p className="text-xs text-[var(--cf-text-muted)] mt-0.5">API keys for other systems and signed event webhooks (ADMIN, 2FA)</p>
            </div>
            <span className="text-[var(--cf-brand)] text-xl">→</span>
          </Link>
          <Link href="/settings/insurers"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🏦 Insurers</p>
              <p className="text-xs text-gray-500 mt-0.5">Underwriting partners for insurance products (restricted)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/integrations"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🔌 Integrations</p>
              <p className="text-xs text-gray-500 mt-0.5">SMS, payments, credit checks, ID verification (ADMIN)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/notifications"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">🔔 Notifications</p>
              <p className="text-xs text-gray-500 mt-0.5">Notification templates & SMS reminders (LOAN_ADMIN+)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/whatsapp"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group col-span-1">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">📱 WhatsApp — status, Cloud API, bridge numbers, templates</p>
              <p className="text-xs text-gray-500 mt-0.5">Server status and channel switches, the official Meta Cloud API connection, the bridge number pool, and loan-event notification templates (ADMIN)</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
        </div>

        {/* Product Management links */}
        <div className="grid grid-cols-2 gap-4">
          <Link href="/settings/products/loan"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">Loan Products</p>
              <p className="text-xs text-gray-500 mt-0.5">Create, edit and manage loan product templates</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
          <Link href="/settings/products/insurance"
            className="flex items-center justify-between p-5 bg-white rounded-xl shadow-sm border border-[#4F46E5]/20 hover:border-[#4F46E5] hover:bg-amber-50 transition-colors group">
            <div>
              <p className="font-semibold text-[#1b1d24] group-hover:text-[#4F46E5]">Insurance Products</p>
              <p className="text-xs text-gray-500 mt-0.5">Define funeral, credit life, motor and home products</p>
            </div>
            <span className="text-[#4F46E5] text-xl">→</span>
          </Link>
        </div>

        {/* Loan Products */}
        <div className="bg-white rounded-lg shadow-sm">
          <div className="p-6 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Loan Products</h3>
            <Link href="/settings/products/loan/new" className="text-sm text-[#4F46E5] hover:underline font-medium">+ New Product</Link>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount Range</TableHead>
                <TableHead>Term Range</TableHead>
                <TableHead>Interest Rate</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((product) => (
                <TableRow key={product.id}>
                  <TableCell className="font-medium">{product.code}</TableCell>
                  <TableCell>{product.name}</TableCell>
                  <TableCell>
                    <Badge className="bg-blue-100 text-blue-800">
                      {product.productType.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {formatZAR(product.minAmount)} - {formatZAR(product.maxAmount)}
                  </TableCell>
                  <TableCell>
                    {product.minTermDays} - {product.maxTermDays} days
                  </TableCell>
                  <TableCell>{(product.interestRatePm * 100).toFixed(1)}% p.m.</TableCell>
                  <TableCell>{product.interestModel.replace("_", " ")}</TableCell>
                  <TableCell>
                    <Badge className={product.active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-800"}>
                      {product.active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Users Summary */}
        <div className="bg-white rounded-lg shadow-sm">
          <div className="p-6 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Users</h3>
            <a href="/settings/users" className="text-sm text-[#4F46E5] hover:underline font-medium">Manage Users →</a>
          </div>
          <div className="p-6">
            <p className="text-sm text-gray-500">{users.length} registered user{users.length !== 1 ? "s" : ""} — {users.filter(u => u.active).length} active</p>
          </div>
        </div>
      </div>
    </>
  )
}

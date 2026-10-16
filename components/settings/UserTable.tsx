"use client"

import { useState, useEffect } from "react"
import { PASSWORD_MIN_LENGTH, passwordPolicyError } from "@/lib/security/password-policy"
import { toast } from "@/lib/toast"
import { Button } from "@/components/ui/button"
import { assignableRoles, canResetTotp, canWriteUser, loadUsers, type SettingsUser as User, type Branch } from "@/lib/settings-users"
import { ResetTotpButton } from "./ResetTotpButton"
import { SAST_TIME_ZONE } from "@/lib/utils"
import {
  Plus, Pencil, UserX, UserCheck, KeyRound, Search,
  Shield, Users, Activity, Clock, Phone, Building2, Trash2
} from "lucide-react"

const ALL_ROLES = [
  { value: "SUPER_ADMIN",         label: "Super Admin",          color: "bg-red-100 text-red-800" },
  { value: "ADMIN",               label: "Admin",                color: "bg-orange-100 text-orange-800" },
  { value: "LOAN_ADMIN",          label: "Loan Admin",           color: "bg-purple-100 text-purple-800" },
  { value: "BRANCH_MANAGER",      label: "Branch Manager",       color: "bg-blue-100 text-blue-800" },
  { value: "CREDIT_OFFICER",      label: "Credit Officer",       color: "bg-indigo-100 text-indigo-800" },
  { value: "COLLECTIONS_OFFICER", label: "Collections Officer",  color: "bg-amber-100 text-amber-800" },
  { value: "COLLECTIONS_AGENT",   label: "Collections Agent",    color: "bg-yellow-100 text-yellow-800" },
  { value: "INSURANCE_OFFICER",   label: "Insurance Officer",    color: "bg-teal-100 text-teal-800" },
  { value: "READONLY",            label: "Read Only",            color: "bg-gray-100 text-gray-600" },
]

const ROLE_PERMISSIONS: Record<string, string[]> = {
  SUPER_ADMIN:         ["Full system access, all settings, user management"],
  ADMIN:               ["All modules, no system settings"],
  LOAN_ADMIN:          ["Loan origination, approval, disbursement"],
  BRANCH_MANAGER:      ["Branch loans, staff, reports"],
  CREDIT_OFFICER:      ["Application capture, affordability, docs"],
  COLLECTIONS_OFFICER: ["Collections stages, S129, attorney referral"],
  COLLECTIONS_AGENT:   ["Payment capture, client contact"],
  INSURANCE_OFFICER:   ["Insurance module only"],
  READONLY:            ["View only — no create/edit/delete"],
}

function roleStyle(role: string) {
  return ALL_ROLES.find(r => r.value === role)?.color ?? "bg-gray-100 text-gray-600"
}
function roleLabel(role: string) {
  return ALL_ROLES.find(r => r.value === role)?.label ?? role
}
function formatDate(d: string | null | undefined) {
  if (!d) return "Never"
  return new Date(d).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", timeZone: SAST_TIME_ZONE })
}
function formatDateTime(d: string | null | undefined) {
  if (!d) return "Never"
  return new Date(d).toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE })
}
function initials(name: string | null | undefined, email: string) {
  if (name) return name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2)
  return email.slice(0, 2).toUpperCase()
}
function avatarColor(id: string) {
  const colors = ["#4338CA","#059669","#3B82F6","#8B5CF6","#EF4444","#F59E0B","#10B981","#6366F1"]
  return colors[id.charCodeAt(0) % colors.length]
}

function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-bold text-gray-900 text-base">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
const selectCls = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-300"

export function UserTable({
  currentUserId, currentUserRole, currentUserTotpVerified = false, staffTotpRequired = true,
}: { currentUserId: string; currentUserRole: string; currentUserTotpVerified?: boolean; staffTotpRequired?: boolean }) {
  const isSuperAdmin = currentUserRole === "SUPER_ADMIN"
  const [users, setUsers] = useState<User[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [filterRole, setFilterRole] = useState("")
  const [filterStatus, setFilterStatus] = useState("")
  const [inviteOpen, setInviteOpen] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [detailUser, setDetailUser] = useState<User | null>(null)

  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    loadUsers()
      .then(data => {
        setUsers(data.users)
        setBranches(data.branches ?? [])
        setError(null)
        setLoading(false)
      })
      .catch(() => {
        setError("Failed to load users.")
        setLoading(false)
      })
  }, [refreshKey])

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    const matchQ = !q || u.name?.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.phone?.toLowerCase().includes(q)
    const matchRole = !filterRole || u.role === filterRole
    const matchStatus = !filterStatus || (filterStatus === "active" ? u.active : !u.active)
    return matchQ && matchRole && matchStatus
  })

  const activeCount = users.filter(u => u.active).length
  const roleGroups = ALL_ROLES.map(r => ({ ...r, count: users.filter(u => u.role === r.value).length })).filter(r => r.count > 0)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">User Management</h1>
          <p className="text-sm text-gray-500 mt-1">{users.length} total · {activeCount} active</p>
        </div>
        <Button onClick={() => setInviteOpen(true)} className="bg-[#4F46E5] hover:bg-[#4338CA]">
          <Plus className="h-4 w-4 mr-2" />Add User
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center"><Users className="h-4 w-4 text-green-600" /></div>
          <div><p className="text-lg font-bold text-gray-900">{activeCount}</p><p className="text-xs text-gray-400">Active users</p></div>
        </div>
        <div className="bg-white rounded-lg border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center"><Shield className="h-4 w-4 text-amber-600" /></div>
          <div><p className="text-lg font-bold text-gray-900">{users.filter(u => ["SUPER_ADMIN","ADMIN","LOAN_ADMIN"].includes(u.role)).length}</p><p className="text-xs text-gray-400">Admins</p></div>
        </div>
        <div className="bg-white rounded-lg border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center"><Building2 className="h-4 w-4 text-blue-600" /></div>
          <div><p className="text-lg font-bold text-gray-900">{branches.length}</p><p className="text-xs text-gray-400">Branches</p></div>
        </div>
        <div className="bg-white rounded-lg border border-gray-100 px-4 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center"><UserX className="h-4 w-4 text-red-500" /></div>
          <div><p className="text-lg font-bold text-gray-900">{users.length - activeCount}</p><p className="text-xs text-gray-400">Inactive</p></div>
        </div>
      </div>

      {/* Role breakdown */}
      {roleGroups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {roleGroups.map(r => (
            <button
              key={r.value}
              onClick={() => setFilterRole(filterRole === r.value ? "" : r.value)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                filterRole === r.value ? "border-amber-400 bg-amber-50" : "border-gray-100 bg-white hover:border-amber-200"
              }`}
            >
              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${r.color}`}>{r.count}</span>
              {r.label}
            </button>
          ))}
          {filterRole && <button onClick={() => setFilterRole("")} className="text-xs text-gray-400 hover:text-gray-600 px-2">✕ Clear</button>}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-300" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, email, phone…" className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-gray-400 text-sm">Loading users…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">No users match your filters</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">User</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase hidden md:table-cell">Role</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase hidden lg:table-cell">Branch</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase hidden lg:table-cell">Last Login</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Status</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(user => (
                <tr key={user.id} className="border-b border-gray-50 hover:bg-amber-50/20 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ backgroundColor: avatarColor(user.id) }}>
                        {initials(user.name, user.email)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900 truncate">{user.name || "—"}</p>
                        <p className="text-[11px] text-gray-400 truncate">{user.email}</p>
                        {user.phone && <p className="text-[10px] text-gray-300 flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{user.phone}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${roleStyle(user.role)}`}>{roleLabel(user.role)}</span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gray-500 hidden lg:table-cell">
                    {user.branch?.name ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-[11px] text-gray-400 hidden lg:table-cell">
                    <div className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {formatDateTime(user.lastLoginAt)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${user.active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                      {user.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => setDetailUser(user)} className="p-1.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600" title="View details"><Activity className="h-4 w-4" /></button>
                      {/* The server refuses any write to a user who ranks above or level with the caller (their own row excepted). */}
                      {canWriteUser(currentUserRole, user.role, user.id === currentUserId) && (
                        <>
                          <button onClick={() => setEditUser(user)} className="p-1.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600" title="Edit user"><Pencil className="h-4 w-4" /></button>
                          <button onClick={() => setResetUser(user)} className="p-1.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600" title="Reset password"><KeyRound className="h-4 w-4" /></button>
                          {canResetTotp({ callerRole: currentUserRole, callerTotpVerified: currentUserTotpVerified, targetRole: user.role, targetEnrolled: user.totpEnabled, isSelf: user.id === currentUserId }) && (
                            <ResetTotpButton user={user} staffTotpRequired={staffTotpRequired} onDone={() => setRefreshKey(k => k + 1)} />
                          )}
                          {user.id !== currentUserId && (
                            <ToggleActiveButton user={user} onDone={() => setRefreshKey(k => k + 1)} />
                          )}
                          {isSuperAdmin && user.id !== currentUserId && (
                            <DeleteUserButton user={user} onDone={() => setRefreshKey(k => k + 1)} />
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} onDone={() => setRefreshKey(k => k + 1)} branches={branches} currentUserRole={currentUserRole} />
      <EditModal user={editUser} onClose={() => setEditUser(null)} onDone={() => setRefreshKey(k => k + 1)} currentUserId={currentUserId} currentUserRole={currentUserRole} branches={branches} />
      <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />
      <UserDetailModal user={detailUser} onClose={() => setDetailUser(null)} />
    </div>
  )
}

function ToggleActiveButton({ user, onDone }: { user: User; onDone: () => void }) {
  const [saving, setSaving] = useState(false)
  async function toggle() {
    if (!confirm(`${user.active ? "Deactivate" : "Reactivate"} ${user.name || user.email}?`)) return
    setSaving(true)
    const res = await fetch(`/api/settings/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !user.active }),
    })
    setSaving(false)
    if (res.ok) { toast.success(user.active ? "User deactivated" : "User reactivated"); onDone() }
    else { const d = await res.json() as { error?: string }; toast.error(d.error ?? "Failed") }
  }
  return (
    <button onClick={toggle} disabled={saving} className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" title={user.active ? "Deactivate" : "Reactivate"}>
      {user.active ? <UserX className="h-4 w-4 text-red-400" /> : <UserCheck className="h-4 w-4 text-green-500" />}
    </button>
  )
}

function DeleteUserButton({ user, onDone }: { user: User; onDone: () => void }) {
  const [saving, setSaving] = useState(false)
  async function remove() {
    if (!confirm(`Delete ${user.name || user.email}?\n\nAccounts with loan, audit or advisory history are deactivated instead of permanently removed.`)) return
    setSaving(true)
    const res = await fetch(`/api/settings/users/${user.id}`, { method: "DELETE" })
    setSaving(false)
    if (res.ok) {
      const d = await res.json() as { mode?: string; message?: string }
      if (d.mode === "deleted") toast.success("User permanently deleted")
      else toast.success(d.message ?? "User deactivated")
      onDone()
    } else {
      const d = await res.json() as { error?: string }
      toast.error(d.error ?? "Failed to delete user")
    }
  }
  return (
    <button onClick={remove} disabled={saving} className="p-1.5 rounded hover:bg-red-50 disabled:opacity-40 text-gray-300 hover:text-red-600" title="Delete user">
      <Trash2 className="h-4 w-4" />
    </button>
  )
}

function InviteModal({ open, onClose, onDone, branches, currentUserRole }: { open: boolean; onClose: () => void; onDone: () => void; branches: Branch[]; currentUserRole: string }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState("")
  const [role, setRole] = useState("CREDIT_OFFICER"); const [password, setPassword] = useState("")
  const [phone, setPhone] = useState(""); const [branchId, setBranchId] = useState("")
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null)

  async function submit() {
    setSaving(true); setError(null)
    const res = await fetch("/api/settings/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, role, password, phone: phone || null, branchId: branchId || null }),
    })
    setSaving(false)
    if (res.ok) { toast.success("User created"); onDone(); onClose(); setName(""); setEmail(""); setPassword(""); setPhone(""); setBranchId("") }
    else { const d = await res.json() as { error?: string }; setError(d.error ?? "Failed") }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add New User">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Full Name *"><input value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="Jane Smith" /></Field>
          <Field label="Email *"><input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="jane@example.com" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><input value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} placeholder="+27 82 000 0000" /></Field>
          <Field label="Branch">
            <select value={branchId} onChange={e => setBranchId(e.target.value)} className={selectCls}>
              <option value="">No branch</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Role *">
          <select value={role} onChange={e => setRole(e.target.value)} className={selectCls}>
            {assignableRoles(ALL_ROLES, currentUserRole).map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">{ROLE_PERMISSIONS[role]?.[0]}</p>
        </Field>
        <Field label="Temporary Password *">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputCls} placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`} />
        </Field>
        {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
        <div className="flex gap-2 pt-2">
          <Button onClick={submit} disabled={saving || !name || !email || !password} className="flex-1 bg-[#4F46E5] hover:bg-[#4338CA]">{saving ? "Creating…" : "Create User"}</Button>
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}

function EditModal({ user, onClose, onDone, currentUserId, currentUserRole, branches }: { user: User | null; onClose: () => void; onDone: () => void; currentUserId: string; currentUserRole: string; branches: Branch[] }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [role, setRole] = useState("")
  const [phone, setPhone] = useState(""); const [branchId, setBranchId] = useState("")
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null)
  const assignable = assignableRoles(ALL_ROLES, currentUserRole)

  useEffect(() => {
    if (!user) return
    Promise.resolve().then(() => {
      setName(user.name ?? ""); setEmail(user.email); setRole(user.role); setPhone(user.phone ?? ""); setBranchId(user.branchId ?? "")
    })
  }, [user])

  async function submit() {
    if (!user) return
    setSaving(true); setError(null)
    const res = await fetch(`/api/settings/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, role, phone: phone || null, branchId: branchId || null }),
    })
    setSaving(false)
    if (res.ok) { toast.success("User updated"); onDone(); onClose() }
    else { const d = await res.json() as { error?: string }; setError(d.error ?? "Failed") }
  }

  return (
    <Modal open={!!user} onClose={onClose} title={`Edit — ${user?.name || user?.email}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Full Name"><input value={name} onChange={e => setName(e.target.value)} className={inputCls} /></Field>
          <Field label="Phone"><input value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} placeholder="+27 82 000 0000" /></Field>
        </div>
        <Field label="Email">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="jane@example.com" />
          {user && email.trim().toLowerCase() !== user.email && (
            <p className="text-[11px] text-amber-600 mt-1">Changing the email signs this user out; they&apos;ll log in with the new address.</p>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <select value={role} onChange={e => setRole(e.target.value)} className={selectCls} disabled={user?.id === currentUserId}>
              {/* The user's current role stays listed so the select shows it, even when the caller could not assign it. */}
              {ALL_ROLES.filter(r => r.value === user?.role || assignable.includes(r)).map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          <Field label="Branch">
            <select value={branchId} onChange={e => setBranchId(e.target.value)} className={selectCls}>
              <option value="">No branch</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        </div>
        {role && <p className="text-[11px] text-gray-400 bg-gray-50 px-3 py-2 rounded">{ROLE_PERMISSIONS[role]?.[0]}</p>}
        {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
        <div className="flex gap-2 pt-2">
          <Button onClick={submit} disabled={saving} className="flex-1 bg-[#4F46E5] hover:bg-[#4338CA]">{saving ? "Saving…" : "Save Changes"}</Button>
          <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}

function ResetPasswordModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [password, setPassword] = useState(""); const [confirm, setConfirm] = useState("")
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!user) return
    Promise.resolve().then(() => { setPassword(""); setConfirm(""); setDone(false); setError(null) })
  }, [user])

  async function submit() {
    if (!user) return
    if (password !== confirm) { setError("Passwords do not match"); return }
    const weak = passwordPolicyError(password)
    if (weak) { setError(weak); return }
    setSaving(true); setError(null)
    const res = await fetch(`/api/settings/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
    setSaving(false)
    if (res.ok) { setDone(true); toast.success("Password reset") }
    else { const d = await res.json() as { error?: string }; setError(d.error ?? "Failed") }
  }

  return (
    <Modal open={!!user} onClose={onClose} title={`Reset Password — ${user?.name || user?.email}`}>
      {done ? (
        <div className="text-center py-6">
          <p className="text-green-600 font-semibold">Password reset successfully.</p>
          <p className="text-sm text-gray-400 mt-1">Notify the user of their new password securely.</p>
          <Button onClick={onClose} className="mt-4 bg-[#4F46E5] hover:bg-[#4338CA]">Done</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="New Password"><input type="password" value={password} onChange={e => setPassword(e.target.value)} className={inputCls} placeholder={`Min. ${PASSWORD_MIN_LENGTH} characters`} /></Field>
          <Field label="Confirm Password"><input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} className={inputCls} placeholder="Repeat password" /></Field>
          {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
          <div className="flex gap-2 pt-2">
            <Button onClick={submit} disabled={saving || !password} className="flex-1 bg-[#4F46E5] hover:bg-[#4338CA]">{saving ? "Resetting…" : "Reset Password"}</Button>
            <Button variant="outline" onClick={onClose} className="flex-1">Cancel</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

type FitAndProper = {
  reExamType: string | null
  reExamPassDate: string | null
  licenceNumber: string | null
  licenceExpiry: string | null
  cpdHoursRequired: number
  cpdHoursCompleted: number
  cpdPeriodEnd: string | null
  notes: string | null
}

function FitAndProperTab({ userId }: { userId: string }) {
  const [data, setData] = useState<FitAndProper | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [form, setForm] = useState<FitAndProper>({
    reExamType: null,
    reExamPassDate: null,
    licenceNumber: null,
    licenceExpiry: null,
    cpdHoursRequired: 30,
    cpdHoursCompleted: 0,
    cpdPeriodEnd: null,
    notes: null,
  })

  useEffect(() => {
    fetch(`/api/users/${userId}/fit-and-proper`)
      .then(r => r.json())
      .then((d: FitAndProper | null) => {
        if (d) {
          setData(d)
          setForm({
            reExamType: d.reExamType ?? null,
            reExamPassDate: d.reExamPassDate ? new Date(d.reExamPassDate).toISOString().slice(0, 10) : null,
            licenceNumber: d.licenceNumber ?? null,
            licenceExpiry: d.licenceExpiry ? new Date(d.licenceExpiry).toISOString().slice(0, 10) : null,
            cpdHoursRequired: d.cpdHoursRequired ?? 30,
            cpdHoursCompleted: d.cpdHoursCompleted ?? 0,
            cpdPeriodEnd: d.cpdPeriodEnd ? new Date(d.cpdPeriodEnd).toISOString().slice(0, 10) : null,
            notes: d.notes ?? null,
          })
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [userId])

  const set = (key: keyof FitAndProper, value: string | number | null) =>
    setForm(f => ({ ...f, [key]: value }))

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSaving(true); setError(null); setSuccess(false)
    const res = await fetch(`/api/users/${userId}/fit-and-proper`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (res.ok) {
      const d = await res.json() as FitAndProper
      setData(d); setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } else {
      const d = await res.json() as { error?: string }
      setError(d.error ?? "Failed to save")
    }
  }

  const inp = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"

  if (loading) return <div className="py-6 text-center text-sm text-gray-400">Loading…</div>

  // Check if licence is expiring within 60 days
  const licenceExpiryWarning = (() => {
    if (!data?.licenceExpiry) return false
    const expiry = new Date(data.licenceExpiry)
    const diffDays = Math.floor((expiry.getTime() - new Date().getTime()) / 86400000)
    return diffDays >= 0 && diffDays <= 60
  })()

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-1">
      {licenceExpiryWarning && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-[12px] text-amber-800 font-medium">
          Licence expires within 60 days — renewal action required.
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">RE Exam Type</label>
          <select value={form.reExamType ?? ""} onChange={e => set("reExamType", e.target.value || null)} className={`${inp} bg-white`}>
            <option value="">— None —</option>
            <option value="RE1">RE1</option>
            <option value="RE5">RE5</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">RE Exam Pass Date</label>
          <input type="date" value={form.reExamPassDate ?? ""} onChange={e => set("reExamPassDate", e.target.value || null)} className={inp} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Licence Number</label>
          <input value={form.licenceNumber ?? ""} onChange={e => set("licenceNumber", e.target.value || null)} className={inp} placeholder="FSP licence #" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">Licence Expiry</label>
          <input type="date" value={form.licenceExpiry ?? ""} onChange={e => set("licenceExpiry", e.target.value || null)} className={inp} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">CPD Hours Required</label>
          <input type="number" min={0} value={form.cpdHoursRequired} onChange={e => set("cpdHoursRequired", parseInt(e.target.value) || 0)} className={inp} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">CPD Hours Completed</label>
          <input type="number" min={0} value={form.cpdHoursCompleted} onChange={e => set("cpdHoursCompleted", parseInt(e.target.value) || 0)} className={inp} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-500 mb-1">CPD Period End</label>
          <input type="date" value={form.cpdPeriodEnd ?? ""} onChange={e => set("cpdPeriodEnd", e.target.value || null)} className={inp} />
        </div>
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-500 mb-1">Notes</label>
        <textarea value={form.notes ?? ""} onChange={e => set("notes", e.target.value || null)} rows={3} className={`${inp} resize-none`} placeholder="Additional compliance notes…" />
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
      {success && <p className="text-xs text-green-700 bg-green-50 px-3 py-2 rounded">Saved successfully.</p>}
      <div className="pt-1">
        <Button type="submit" disabled={saving} className="bg-[#4F46E5] hover:bg-[#4338CA]">
          {saving ? "Saving…" : "Save Fit & Proper"}
        </Button>
      </div>
    </form>
  )
}

function UserDetailModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"overview" | "fit-and-proper">("overview")

  useEffect(() => {
    if (!user) return
    Promise.resolve().then(() => setActiveTab("overview"))
  }, [user])

  if (!user) return null
  return (
    <Modal open={!!user} onClose={onClose} title="User Details">
      <div className="space-y-4">
        {/* Avatar + name */}
        <div className="flex items-center gap-4 pb-3 border-b border-gray-50">
          <div className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold"
            style={{ backgroundColor: avatarColor(user.id) }}>
            {initials(user.name, user.email)}
          </div>
          <div>
            <p className="font-bold text-gray-900 text-base">{user.name || "—"}</p>
            <p className="text-sm text-gray-400">{user.email}</p>
            {user.phone && <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5"><Phone className="h-3 w-3" />{user.phone}</p>}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
          {(["overview", "fit-and-proper"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1 rounded-md text-[11px] font-semibold capitalize transition-colors ${
                activeTab === tab ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab === "fit-and-proper" ? "Fit & Proper" : "Overview"}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-xs text-gray-400 mb-0.5">Role</p><span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${roleStyle(user.role)}`}>{roleLabel(user.role)}</span></div>
              <div><p className="text-xs text-gray-400 mb-0.5">Status</p><span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${user.active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>{user.active ? "Active" : "Inactive"}</span></div>
              <div><p className="text-xs text-gray-400 mb-0.5">Branch</p><p className="font-medium text-gray-700">{user.branch?.name ?? "—"}</p></div>
              <div><p className="text-xs text-gray-400 mb-0.5">Member since</p><p className="font-medium text-gray-700">{formatDate(user.createdAt)}</p></div>
              <div className="col-span-2"><p className="text-xs text-gray-400 mb-0.5">Last login</p><p className="font-medium text-gray-700 flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-gray-300" />{formatDateTime(user.lastLoginAt)}</p></div>
            </div>

            {user._count && (
              <div className="grid grid-cols-3 gap-2 pt-2 border-t border-gray-50">
                <div className="text-center bg-gray-50 rounded-lg py-2">
                  <p className="text-lg font-bold text-gray-800">{user._count.assignedLoans}</p>
                  <p className="text-[10px] text-gray-400">Assigned</p>
                </div>
                <div className="text-center bg-gray-50 rounded-lg py-2">
                  <p className="text-lg font-bold text-gray-800">{user._count.approvedLoans}</p>
                  <p className="text-[10px] text-gray-400">Approved</p>
                </div>
                <div className="text-center bg-gray-50 rounded-lg py-2">
                  <p className="text-lg font-bold text-gray-800">{user._count.auditLogs}</p>
                  <p className="text-[10px] text-gray-400">Actions</p>
                </div>
              </div>
            )}

            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <p className="text-[11px] font-semibold text-amber-800">Permissions</p>
              <p className="text-[11px] text-amber-600 mt-0.5">{ROLE_PERMISSIONS[user.role]?.[0]}</p>
            </div>
          </>
        )}

        {activeTab === "fit-and-proper" && (
          <FitAndProperTab userId={user.id} />
        )}
      </div>
    </Modal>
  )
}

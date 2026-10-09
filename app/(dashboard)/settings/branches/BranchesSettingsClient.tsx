"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Plus, Building2, Users, FileText, Loader2 } from "lucide-react"

interface Branch {
  id: string
  name: string
  code: string
  address: string | null
  phone: string | null
  managerId: string | null
  active: boolean
  userCount: number
  applicationCount: number
  clientCount: number
  createdAt: string
}

interface Manager {
  id: string
  name: string | null
  email: string
}

interface Props {
  initialBranches: Branch[]
  managers: Manager[]
}

export function BranchesSettingsClient({ initialBranches, managers }: Props) {
  const [branches, setBranches] = useState(initialBranches)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [address, setAddress] = useState("")
  const [phone, setPhone] = useState("")
  const [managerId, setManagerId] = useState("")

  const handleCreate = async () => {
    if (!name.trim() || !code.trim()) {
      setError("Name and code are required")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, code, address: address || undefined, phone: phone || undefined, managerId: managerId || undefined }),
      })
      if (res.ok) {
        const created = await res.json() as Branch & { _count?: unknown }
        setBranches((prev) => [...prev, { ...created, userCount: 0, applicationCount: 0, clientCount: 0 }])
        setShowForm(false)
        setName(""); setCode(""); setAddress(""); setPhone(""); setManagerId("")
      } else {
        const data = await res.json() as { error?: string }
        setError(data.error ?? "Failed to create branch")
      }
    } catch {
      setError("Network error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[#1b1d24]">Branches</h2>
          <p className="text-sm text-gray-500">{branches.length} branch{branches.length !== 1 ? "es" : ""}</p>
        </div>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="h-4 w-4 mr-1.5" />Add Branch
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5 space-y-4">
          <h3 className="font-semibold text-[#1b1d24]">New Branch</h3>
          {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Branch Name *</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Johannesburg CBD" className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Branch Code *</label>
              <input type="text" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. JHB-CBD" className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[#4F46E5]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Address</label>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)}
                placeholder="Street address" className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Phone</label>
              <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder="+27 11 xxx xxxx" className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5]" />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Branch Manager</label>
              <select value={managerId} onChange={(e) => setManagerId(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5]">
                <option value="">Select manager (optional)</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.email}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button size="sm" onClick={handleCreate} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              {saving ? "Saving..." : "Create Branch"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowForm(false); setError(null) }}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Branch cards */}
      {branches.length === 0 ? (
        <div className="bg-white rounded-lg border border-[#e5e7eb] p-12 text-center">
          <Building2 className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">No branches configured</p>
          <p className="text-gray-400 text-sm mt-1">Add your first branch to assign staff and clients.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {branches.map((branch) => (
            <div key={branch.id} className="bg-white rounded-lg border border-[#e5e7eb] p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-[#1b1d24]">{branch.name}</h3>
                  <code className="text-xs text-gray-400 font-mono">{branch.code}</code>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${branch.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                  {branch.active ? "Active" : "Inactive"}
                </span>
              </div>
              {branch.address && <p className="text-xs text-gray-500 mb-1">{branch.address}</p>}
              {branch.phone && <p className="text-xs text-gray-500 mb-3">{branch.phone}</p>}
              <div className="flex gap-4 text-xs text-gray-400 border-t border-[#eceef2] pt-3">
                <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{branch.userCount} staff</span>
                <span className="flex items-center gap-1"><FileText className="h-3.5 w-3.5" />{branch.applicationCount} apps</span>
                <span className="flex items-center gap-1"><Building2 className="h-3.5 w-3.5" />{branch.clientCount} clients</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

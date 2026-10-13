import { waHref } from "@/lib/support/whatsapp-intents"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { User, Shield } from "lucide-react"
import { ProfileForm } from "./ProfileForm"
import { PasswordFields } from "./PasswordFields"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLenderIdentity } from "@/lib/config/identity"
import { maskIdNumber, SAST_TIME_ZONE } from "@/lib/utils"

function maskAccountNumber(acc: string | null): string {
  if (!acc) return "---"
  if (acc.length <= 4) return acc
  return "*".repeat(acc.length - 4) + acc.slice(-4)
}

export default async function ProfilePage() {
  const session = await auth()
  if (!session?.user?.email) redirect("/portal/login")

  const tenantId = await getPortalTenantId()
  const identity = await getLenderIdentity(tenantId)

  const client = await prisma.client.findFirst({
    where: { email: session.user.email, tenantId },
    include: { consent: true },
  })

  if (!client) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center">
          <p className="text-gray-500">No client profile found.</p>
          <p className="text-sm text-gray-400 mt-2">
            Contact {identity.publicEmail} for assistance.
          </p>
        </div>
      </div>
    )
  }

  const dob = client.dateOfBirth
    ? new Date(client.dateOfBirth).toLocaleDateString("en-ZA", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: SAST_TIME_ZONE,
      })
    : "Not set"

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-8">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ backgroundColor: "#4338CA20" }}
        >
          <User className="w-5 h-5" style={{ color: "#4338CA" }} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">My Profile</h1>
          <p className="text-sm text-gray-500">
            View and manage your personal information
          </p>
        </div>
      </div>

      {/* Read-only personal info */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
        <h2 className="text-sm font-bold text-gray-900 mb-4">
          Personal Information
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadOnlyField label="Full Name" value={`${client.firstName} ${client.lastName}`} />
          <ReadOnlyField label="ID Number" value={maskIdNumber(client.idNumber)} />
          <ReadOnlyField label="Date of Birth" value={dob} />
          <ReadOnlyField label="Email" value={client.email} />
        </div>
      </div>

      {/* Editable contact & address */}
      <ProfileForm
        initialData={{
          phone: client.phone,
          whatsapp: client.whatsapp || "",
          addressLine1: client.addressLine1 || "",
          suburb: client.suburb || "",
          city: client.city || "",
          province: client.province || "",
          postalCode: client.postalCode || "",
        }}
        consent={client.consent}
      />

      {/* Banking details */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
        <h2 className="text-sm font-bold text-gray-900 mb-4">
          Banking Details
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReadOnlyField label="Bank" value={client.bankName || "---"} />
          <ReadOnlyField
            label="Account Number"
            value={maskAccountNumber(client.bankAccountNumber)}
          />
          <ReadOnlyField label="Branch Code" value={client.bankBranchCode || "---"} />
        </div>
        <p className="text-xs text-gray-400 mt-4">
          To update banking details, please contact us or visit a branch.
        </p>
        {identity.publicWhatsappE164 && (
          <a
            href={waHref(identity.publicWhatsappE164, "Hi, I need to update my banking details")}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors hover:bg-amber-50/50"
            style={{ borderColor: "#4338CA", color: "#4338CA" }}
          >
            Request Update
          </a>
        )}
      </div>

      {/* Password change */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 mb-5">
        <h2 className="text-sm font-bold text-gray-900 mb-4">
          Change Password
        </h2>
        <PasswordFields />
      </div>

      {/* POPIA */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4" style={{ color: "#4338CA" }} />
          <h2 className="text-sm font-bold text-gray-900">Your Data Rights</h2>
        </div>
        <details className="group">
          <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-900 transition-colors list-none flex items-center gap-1">
            <span className="text-xs transition-transform group-open:rotate-90">&#9654;</span>
            POPIA Information
          </summary>
          <div className="mt-3 text-xs text-gray-500 space-y-2">
            <p>
              Under the Protection of Personal Information Act (POPIA), you have the right to:
            </p>
            <ul className="list-disc ml-4 space-y-1">
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate information</li>
              <li>Request deletion of your information (subject to legal retention requirements)</li>
              <li>Object to the processing of your personal information</li>
              <li>Lodge a complaint with the Information Regulator</li>
            </ul>
            <p>
              For more details, see our{" "}
              <a
                href="/site/privacy"
                className="underline"
                style={{ color: "#4338CA" }}
              >
                Privacy Policy
              </a>
              .
            </p>
          </div>
        </details>
      </div>
    </div>
  )
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-400 mb-1">
        {label}
      </p>
      <p className="text-sm text-gray-900 font-medium">{value}</p>
    </div>
  )
}

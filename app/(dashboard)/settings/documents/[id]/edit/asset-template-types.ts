// Props the asset-finance template editor receives from its server page. JSON-safe.
import type { DocumentTemplateApprovalBasis, DocumentTemplateVersionStatus } from "@prisma/client"
import type { AdditionalTerm, AssetTemplateContent } from "@/lib/asset-finance/documents/templates/content"

export interface EditableClauseView {
  id: string
  number: string
  heading: string
  starter: string
  requiredTokens: string[]
}

export interface AssetVersionView {
  id: string
  version: number
  status: DocumentTemplateVersionStatus
  createdAt: string
  createdById: string | null
  createdBy: string
  notes: string | null
  contentSha256: string
  content: AssetTemplateContent
  approvedById: string | null
  approvedBy: string | null
  approvedAt: string | null
  approvalBasis: DocumentTemplateApprovalBasis | null
  legalSignOffReference: string | null
  activatedBy: string | null
  activatedAt: string | null
}

export interface AssetTemplateEditorProps {
  templateId: string
  templateKey: string
  variantLabel: string
  editable: EditableClauseView[]
  protectedSummary: string
  takesLenderText: boolean
  /** The deal shapes a preview can show (every branch of the protected wording). */
  shapes: { id: string; label: string }[]
  tokens: { token: string; label: string }[]
  firstAdditionalNumber: string
  currentUserId: string
  currentUserRole: string
  isDemoLender: boolean
  starterRevision: string
  versions: AssetVersionView[]
}

export type { AdditionalTerm, AssetTemplateContent }

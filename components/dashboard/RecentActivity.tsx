import { formatDate, formatZAR } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface Application {
  id: string
  reference: string
  clientName: string
  appliedAmount: number
  status: string
  createdAt: Date
}

interface RecentActivityProps {
  applications: Application[]
}

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-800",
  SUBMITTED: "bg-blue-100 text-blue-800",
  UNDER_REVIEW: "bg-amber-100 text-amber-800",
  APPROVED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  DISBURSED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-gray-100 text-gray-800",
}

export function RecentActivity({ applications }: RecentActivityProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm">
      <div className="p-6 border-b border-gray-100">
        <h3 className="text-lg font-semibold text-gray-900">Recent Applications</h3>
      </div>
      {applications.length === 0 ? (
        <div className="p-6 text-center text-gray-500">
          No applications yet
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((app) => (
              <TableRow key={app.id}>
                <TableCell className="font-medium">{app.reference}</TableCell>
                <TableCell>{app.clientName}</TableCell>
                <TableCell>{formatZAR(app.appliedAmount)}</TableCell>
                <TableCell>
                  <Badge className={statusColors[app.status] || "bg-gray-100"}>
                    {app.status.replace("_", " ")}
                  </Badge>
                </TableCell>
                <TableCell>{formatDate(app.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

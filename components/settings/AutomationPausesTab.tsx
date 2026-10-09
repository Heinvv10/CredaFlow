"use client"

import { Button } from "@/components/ui/button"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { formatDateTime } from "@/lib/utils"
import { PlayCircle } from "lucide-react"

export interface Pause {
  id: string; ruleId: string; entityType: string; entityId: string; createdAt: string
  rule: { name: string; trigger: string; action: string }
}

interface Props {
  pauses: Pause[]
  loading: boolean
  pausingId: string | null
  onResume: (pauseId: string) => void
}

export function AutomationPausesTab({ pauses, loading, pausingId, onResume }: Props) {
  if (loading) return <div className="p-8 text-center text-gray-400">Loading…</div>

  if (pauses.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        No pauses active. Use the pause button in the Activity log to suppress a rule for a specific entity.
      </div>
    )
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Rule</TableHead>
            <TableHead>Entity</TableHead>
            <TableHead>Paused Since</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pauses.map((pause) => (
            <TableRow key={pause.id}>
              <TableCell>
                <p className="font-medium text-sm">{pause.rule.name}</p>
                <p className="text-xs text-gray-400">{pause.rule.trigger} → {pause.rule.action}</p>
              </TableCell>
              <TableCell className="text-sm">
                <span className="text-gray-500">{pause.entityType}/</span>
                <span className="font-mono text-xs">{pause.entityId.slice(-8)}</span>
              </TableCell>
              <TableCell className="text-xs text-gray-400">{formatDateTime(pause.createdAt)}</TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-green-600 hover:text-green-800"
                  disabled={pausingId === pause.id}
                  onClick={() => onResume(pause.id)}
                >
                  <PlayCircle className="h-3 w-3 mr-1" />
                  Resume
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-gray-400 mt-3 px-1">
        Paused automations are skipped by the engine and logged as &quot;skipped&quot;. Remove the pause to resume normal execution.
      </p>
    </>
  )
}

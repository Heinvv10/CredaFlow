import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

/**
 * Read-only Experian status. Credentials live in the server environment (.env),
 * so this surfaces configured/not-configured status only — nothing is editable.
 */
export function ExperianStatusCard({ configured, env }: { configured: boolean; env: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Experian (Sigma) Credit Bureau</CardTitle>
            <CardDescription>
              Bureau enquiries for application decisioning. Credentials are managed in the server
              environment (.env) and cannot be edited here.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {env && <Badge variant="outline">{env}</Badge>}
            <Badge variant={configured ? "default" : "secondary"}>
              {configured ? "Configured" : "Not configured"}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {configured
            ? "Experian credentials are present. Score-gate thresholds are managed under Settings → Credit Policy."
            : "Set EXPERIAN_USERNAME and EXPERIAN_PASSWORD in the server environment to enable bureau enquiries."}
        </p>
      </CardContent>
    </Card>
  )
}

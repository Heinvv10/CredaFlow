import { LucideIcon } from "lucide-react"

interface KpiCardProps {
  title: string
  value: string
  subtitle?: string
  change?: string
  changeType?: "positive" | "negative" | "neutral"
  icon?: LucideIcon
  variant?: string
  accentColor?: string
}

export function KpiCard({
  title,
  value,
  subtitle,
  change,
  changeType = "neutral",
  icon: _Icon,
  variant,
  accentColor,
}: KpiCardProps) {
  // Use accentColor or variant, default to gold
  const colorClass = accentColor || variant || "gold"
  const variantClass = colorClass !== "gold" ? colorClass : ""
  const displayText = subtitle || change

  return (
    <div className={`stat-card ${variantClass}`}>
      <div className="stat-label">{title}</div>
      <div className="whitespace-nowrap stat-value">{value}</div>
      {displayText && (
        <div
          className="stat-sub"
          style={{
            color: changeType === "positive" ? "#1e6b3f"
              : changeType === "negative" ? "#b71c1c"
              : "#a9aeb9"
          }}
        >
          {displayText}
        </div>
      )}
    </div>
  )
}

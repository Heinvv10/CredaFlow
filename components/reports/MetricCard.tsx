interface MetricCardProps {
  title: string
  value: string
  subtitle?: string
  color?: "green" | "orange" | "red" | "blue" | "gray"
}

const colorMap = {
  green: { border: "#1e6b3f", bg: "bg-green-50", text: "text-green-700" },
  orange: { border: "#e65100", bg: "bg-orange-50", text: "text-orange-700" },
  red: { border: "#b71c1c", bg: "bg-red-50", text: "text-red-700" },
  blue: { border: "#1565c0", bg: "bg-blue-50", text: "text-blue-700" },
  gray: { border: "#6b7280", bg: "bg-gray-50", text: "text-gray-700" },
}

export function MetricCard({ title, value, subtitle, color = "gray" }: MetricCardProps) {
  const c = colorMap[color]
  return (
    <div
      className="bg-white rounded-lg shadow-sm p-5 relative overflow-hidden"
      style={{ borderLeft: `4px solid ${c.border}` }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.8px] text-[#8f95a3] mb-1.5">
        {title}
      </p>
      <p className={`whitespace-nowrap text-[22px] font-extrabold leading-none ${c.text}`}>{value}</p>
      {subtitle && <p className="text-[11px] text-[#a9aeb9] mt-1.5">{subtitle}</p>}
    </div>
  )
}

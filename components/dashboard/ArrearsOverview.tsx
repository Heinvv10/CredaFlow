import { formatZAR } from "@/lib/utils"
import { Progress } from "@/components/ui/progress"

interface ArrearsBucket {
  label: string
  count: number
  amount: number
  color: string
}

interface ArrearsOverviewProps {
  buckets: ArrearsBucket[]
  totalArrears: number
}

export function ArrearsOverview({ buckets, totalArrears }: ArrearsOverviewProps) {
  const totalCount = buckets.reduce((sum, b) => sum + b.count, 0)

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-semibold text-gray-900">Arrears Overview</h3>
        <div className="text-right">
          <p className="text-2xl font-bold text-red-600">{formatZAR(totalArrears)}</p>
          <p className="text-sm text-gray-500">Total in Arrears</p>
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="text-center text-gray-500 py-8">
          No loans in arrears
        </div>
      ) : (
        <div className="space-y-4">
          {buckets.map((bucket) => (
            <div key={bucket.label} className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-gray-700">{bucket.label}</span>
                <span className="text-gray-500">
                  {bucket.count} loans ({formatZAR(bucket.amount)})
                </span>
              </div>
              <Progress
                value={totalCount > 0 ? (bucket.count / totalCount) * 100 : 0}
                className="h-2"
                style={{
                  ["--progress-background" as string]: bucket.color,
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

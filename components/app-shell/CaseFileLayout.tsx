import { cn } from "@/lib/utils"

type CaseFileLayoutProps = {
  context: React.ReactNode
  workspace: React.ReactNode
  actions: React.ReactNode
  className?: string
}

export function CaseFileLayout({ context, workspace, actions, className }: CaseFileLayoutProps) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-4 xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)_minmax(220px,300px)]",
        className
      )}
    >
      <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">{context}</aside>
      <section className="min-w-0 space-y-4">{workspace}</section>
      <aside className="min-w-0 xl:sticky xl:top-20 xl:self-start">{actions}</aside>
    </div>
  )
}

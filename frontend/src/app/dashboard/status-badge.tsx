import type { DeploymentStatus } from "@/lib/types";

const styles: Record<DeploymentStatus, { dot: string; label: string }> = {
  queued: { dot: "bg-amber-400", label: "Building" },
  ready: { dot: "bg-emerald-500", label: "Ready" },
  failed: { dot: "bg-red-500", label: "Failed" },
};

export function StatusBadge({ status }: { status: DeploymentStatus }) {
  const style = styles[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={`size-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Deployment } from "@/lib/types";
import { StatusBadge } from "../status-badge";
import { BuildLogs } from "./build-logs";

export default function DeploymentPage({ params }: PageProps<"/dashboard/[slug]">) {
  return (
    <div className="flex flex-col gap-8">
      <Link href="/dashboard" className="text-sm text-muted hover:text-foreground">
        ← Deployments
      </Link>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-md bg-surface" />}>
        <DeploymentDetails params={params} />
      </Suspense>
    </div>
  );
}

async function DeploymentDetails({ params }: { params: Promise<{ slug: string }> }) {
  await connection();
  const { slug } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("deployments")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();

  if (!data) notFound();
  const deployment = data as Deployment;

  const { data: logs } = await supabase
    .from("deployment_logs")
    .select("log")
    .eq("slug", slug)
    .order("id", { ascending: true });
  const savedLines = (logs ?? []).map((row: { log: string }) => row.log.trimEnd());

  return (
    <>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{deployment.slug}</h1>
          <StatusBadge status={deployment.status} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">Repository</dt>
          <dd className="truncate font-mono text-xs leading-5">{deployment.git_url}</dd>
          <dt className="text-muted">URL</dt>
          <dd className="truncate">
            {deployment.url ? (
              <a href={deployment.url} target="_blank" rel="noreferrer" className="hover:underline">
                {deployment.url} ↗
              </a>
            ) : (
              <span className="text-muted">—</span>
            )}
          </dd>
        </dl>
      </div>

      <BuildLogs
        id={deployment.id}
        slug={deployment.slug}
        status={deployment.status}
        savedLines={savedLines}
      />
    </>
  );
}

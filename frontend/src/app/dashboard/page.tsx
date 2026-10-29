import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { Deployment } from "@/lib/types";
import { DeployForm } from "./deploy-form";
import { StatusBadge } from "./status-badge";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function repoName(gitURL: string) {
  return gitURL.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");
}

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-12">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">New deployment</h1>
        <DeployForm />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-medium text-muted">Deployments</h2>
        <Suspense
          fallback={<div className="h-32 animate-pulse rounded-md border border-border bg-surface" />}
        >
          <DeploymentList />
        </Suspense>
      </section>
    </div>
  );
}

async function DeploymentList() {
  await connection();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deployments")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return <p className="text-sm text-red-500">{error.message}</p>;

  const deployments = (data ?? []) as Deployment[];

  if (deployments.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted">
        Nothing deployed yet. Paste a repository URL above to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {deployments.map((deployment) => (
        <li
          key={deployment.id}
          className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <Link
              href={`/dashboard/${deployment.slug}`}
              className="truncate text-sm font-medium hover:underline"
            >
              {deployment.slug}
            </Link>
            <span className="truncate font-mono text-xs text-muted">
              {repoName(deployment.git_url)}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <Link
              href={`/dashboard/${deployment.slug}`}
              className="text-xs text-muted hover:text-foreground"
            >
              Logs
            </Link>
            {deployment.url && (
              <a
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted hover:text-foreground"
              >
                Visit ↗
              </a>
            )}
            <StatusBadge status={deployment.status} />
            <span className="w-24 text-right text-xs text-muted">
              {formatDate(deployment.created_at)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

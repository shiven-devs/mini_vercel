"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";
import type { DeploymentStatus } from "@/lib/types";

type Props = {
  id: string;
  slug: string;
  status: DeploymentStatus;
  // Lines saved by api-server before this page loaded.
  savedLines: string[];
};

// Final lines published by build_server/script.js.
const SUCCESS_LINE = "Deployment Complete!";
const FAILURE_PREFIX = "Deployment failed";

function parseMessage(message: unknown) {
  if (typeof message !== "string") return String(message);
  try {
    const parsed = JSON.parse(message);
    return typeof parsed?.log === "string" ? parsed.log : message;
  } catch {
    return message;
  }
}

export function BuildLogs({ id, slug, status, savedLines }: Props) {
  const router = useRouter();
  const [lines, setLines] = useState<string[]>(savedLines.filter(Boolean));
  const bottomRef = useRef<HTMLDivElement>(null);
  const isBuilding = status === "queued";

  useEffect(() => {
    if (!isBuilding) return;

    const supabase = createClient();
    const socket = io(process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:9002");

    async function finish(next: DeploymentStatus) {
      await supabase.from("deployments").update({ status: next }).eq("id", id);
      router.refresh();
    }

    socket.on("connect", () => socket.emit("subscribe", `logs:${slug}`));
    socket.on("message", (message: unknown) => {
      const line = parseMessage(message).trimEnd();
      if (!line) return;
      setLines((previous) => [...previous, line]);

      if (line.includes(SUCCESS_LINE)) finish("ready");
      else if (line.startsWith(FAILURE_PREFIX)) finish("failed");
    });

    return () => {
      socket.disconnect();
    };
  }, [id, slug, isBuilding, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted">Build logs</h2>
      <div className="h-96 overflow-auto rounded-md border border-border bg-surface p-4 font-mono text-xs leading-relaxed">
        {lines.length === 0 && (
          <p className="text-muted">
            {isBuilding
              ? "Waiting for the build container to start…"
              : "No logs were saved for this build."}
          </p>
        )}
        {lines.map((line, index) => (
          <pre key={index} className="whitespace-pre-wrap break-words">
            {line}
          </pre>
        ))}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

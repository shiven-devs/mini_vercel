"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateSlug } from "random-word-slugs";
import { createClient } from "@/lib/supabase/server";

export type DeployState = { error?: string } | undefined;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isGitUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function deploy(_: DeployState, formData: FormData): Promise<DeployState> {
  const gitURL = String(formData.get("gitURL") ?? "").trim();
  const requestedSlug = String(formData.get("slug") ?? "").trim().toLowerCase();

  if (!isGitUrl(gitURL)) return { error: "Enter a valid Git repository URL." };
  if (requestedSlug && !SLUG_PATTERN.test(requestedSlug)) {
    return { error: "Project name may only contain lowercase letters, numbers and hyphens." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const slug = requestedSlug || generateSlug();

  // Reserve the slug first; the unique constraint stops two users claiming the same subdomain.
  const { data: deployment, error: insertError } = await supabase
    .from("deployments")
    .insert({ user_id: user.id, git_url: gitURL, slug })
    .select("id")
    .single();

  if (insertError) {
    return {
      error:
        insertError.code === "23505"
          ? "That project name is already taken."
          : insertError.message,
    };
  }

  try {
    const response = await fetch(`${process.env.API_SERVER_URL}/project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitURL, slug }),
      cache: "no-store",
    });
    const body = await response.json();

    if (!response.ok) throw new Error(body.error ?? "Deployment could not be started.");

    await supabase
      .from("deployments")
      .update({ url: body.data.url })
      .eq("id", deployment.id);
  } catch (error) {
    await supabase.from("deployments").update({ status: "failed" }).eq("id", deployment.id);
    revalidatePath("/dashboard");
    return {
      error: error instanceof Error ? error.message : "Deployment could not be started.",
    };
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/${slug}`);
}

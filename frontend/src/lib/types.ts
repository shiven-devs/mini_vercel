export type DeploymentStatus = "queued" | "ready" | "failed";

export type Deployment = {
  id: string;
  user_id: string;
  git_url: string;
  slug: string;
  url: string | null;
  status: DeploymentStatus;
  created_at: string;
};

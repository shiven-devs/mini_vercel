"use client";

import { useActionState } from "react";
import { deploy } from "./actions";

export function DeployForm() {
  const [state, formAction, pending] = useActionState(deploy, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          className="input sm:flex-[2]"
          name="gitURL"
          type="url"
          placeholder="https://github.com/user/repo"
          required
        />
        <input
          className="input sm:flex-1"
          name="slug"
          placeholder="project-name (optional)"
          pattern="[a-z0-9\-]+"
          title="Lowercase letters, numbers and hyphens"
        />
        <button className="btn shrink-0" type="submit" disabled={pending}>
          {pending ? "Deploying…" : "Deploy"}
        </button>
      </div>
      {state?.error && <p className="text-sm text-red-500">{state.error}</p>}
    </form>
  );
}

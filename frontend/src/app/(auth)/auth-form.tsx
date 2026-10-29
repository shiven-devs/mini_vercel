"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { AuthState } from "./actions";

type Props = {
  mode: "login" | "signup";
  action: (state: AuthState, formData: FormData) => Promise<AuthState>;
};

const copy = {
  login: {
    title: "Log in",
    submit: "Log in",
    pending: "Logging in…",
    switchText: "No account?",
    switchLabel: "Sign up",
    switchHref: "/signup",
  },
  signup: {
    title: "Create an account",
    submit: "Sign up",
    pending: "Creating account…",
    switchText: "Already have an account?",
    switchLabel: "Log in",
    switchHref: "/login",
  },
};

export function AuthForm({ mode, action }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const text = copy[mode];

  return (
    <div className="w-full max-w-sm">
      <h1 className="mb-8 text-2xl font-semibold tracking-tight">{text.title}</h1>

      <form action={formAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          Email
          <input
            className="input"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          Password
          <input
            className="input"
            name="password"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={6}
            required
          />
        </label>

        {state?.error && <p className="text-sm text-red-500">{state.error}</p>}
        {state?.message && <p className="text-sm text-muted">{state.message}</p>}

        <button className="btn mt-2" type="submit" disabled={pending}>
          {pending ? text.pending : text.submit}
        </button>
      </form>

      <p className="mt-6 text-sm text-muted">
        {text.switchText}{" "}
        <Link href={text.switchHref} className="text-foreground underline-offset-4 hover:underline">
          {text.switchLabel}
        </Link>
      </p>
    </div>
  );
}

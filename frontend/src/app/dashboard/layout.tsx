import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { signout } from "../(auth)/actions";

async function UserEmail() {
  await connection();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return <span className="hidden text-sm text-muted sm:inline">{user?.email}</span>;
}

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-4">
          <Link href="/dashboard" className="font-mono text-sm">
            ▲ deploy
          </Link>
          <div className="flex items-center gap-2">
            <Suspense>
              <UserEmail />
            </Suspense>
            <form action={signout}>
              <button className="btn-ghost" type="submit">
                Log out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">{children}</main>
    </div>
  );
}

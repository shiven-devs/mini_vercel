# Frontend

Next.js dashboard for the deploy service: sign up / log in with Supabase, deploy a Git repository, and view each project's link and build logs.

## Setup

1. **Database.** In the Supabase dashboard, open the SQL Editor and run [`supabase/schema.sql`](supabase/schema.sql). It creates the `deployments` and `deployment_logs` tables with row-level security.
2. **Frontend env.** Copy `.env.example` to `.env.local` and fill in your Supabase URL and anon key.
3. **Backend env.** In the root `.env`, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` so `api-server` can save build logs and update deployment status.
4. **Auth redirect.** In Supabase → Authentication → URL Configuration, add `http://localhost:3000/auth/callback` as a redirect URL (needed only if email confirmation is on).

## Run

Start the backend services (`api-server`, `s3-reverse-proxy`) and then:

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## How it works

- `src/app/dashboard/actions.ts` saves the deployment in Supabase, then calls `POST /project` on `api-server`. The browser never calls the API directly.
- `src/app/dashboard/[slug]` shows the saved logs from `deployment_logs` and streams new lines live from the Socket.IO server (`logs:<slug>` room).
- `api-server` writes every log line it receives from Redis to `deployment_logs`, and sets the deployment to `ready` or `failed` when the build ends.

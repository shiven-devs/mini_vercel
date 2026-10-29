# Deploy

A self-hosted deployment platform. Paste a GitHub URL, and the project is cloned, built in an isolated container, uploaded to S3, and served on its own subdomain — with build logs streaming live to the browser.

---

## How it works

```
Browser ──> Next.js frontend ──> API server ──> AWS ECS (Fargate)
                                     │                  │
                                     │                  ├─ git clone
                                     │                  ├─ npm install && npm run build
                                     │                  └─ upload to S3
                                     │                  │
                                     │   logs           ▼
                                     └──── Redis Pub/Sub
                                     │
                                     ▼
                              Socket.IO ──> live logs in browser


Visitor ──> slug.yourdomain.com ──> reverse proxy ──> S3/__outputs/slug/
```

1. A user signs in and submits a Git URL from the dashboard.
2. The **API server** records the deployment in Supabase and starts an **ECS Fargate** task.
3. The **build server** container clones the repo, detects whether it needs a build step, runs it, and uploads the output to **S3** under `__outputs/<slug>/`.
4. Every log line is published to **Redis**, picked up by the API server, saved to Supabase, and pushed to the browser over **Socket.IO**.
5. The **reverse proxy** maps `<slug>.yourdomain.com` to that project's folder in S3.

---

## Services

| Folder | What it does | Port (local) |
|---|---|---|
| [`frontend/`](frontend/) | Next.js dashboard — auth, deployments, live logs | 3000 |
| [`api-server/`](api-server/) | Starts builds, forwards logs over Socket.IO | 9000 (API), 9002 (socket) |
| [`build_server/`](build_server/) | Docker image that clones, builds and uploads | runs on ECS |
| [`s3-reverse-proxy/`](s3-reverse-proxy/) | Serves deployed sites by subdomain | 8000 |

---

## Tech stack

**Frontend** — Next.js 16 (App Router, Server Actions), React 19, TypeScript, Tailwind CSS v4, Supabase Auth

**Backend** — Node.js, Express 5, Socket.IO, Redis Pub/Sub, PostgreSQL (Supabase) with Row-Level Security

**Infrastructure** — AWS ECS Fargate, AWS S3, Docker

---

## Prerequisites

Before you start you need:

- **Node.js 20+** and npm
- **Docker** — to build the build-server image
- An **AWS account** with:
  - an S3 bucket for build output
  - an ECS cluster and a Fargate task definition
  - an ECR repository (to host the build image)
- A **Redis** instance — [Upstash](https://upstash.com/) or [Aiven](https://aiven.io/) both have free tiers
- A **Supabase** project — [supabase.com](https://supabase.com)

---

## Local setup

### 1. Clone and install

```bash
git clone <this-repo>
cd "network intrusion system"

npm install --prefix api-server
npm install --prefix s3-reverse-proxy
npm install --prefix frontend
```

### 2. Set up the database

In your Supabase project, open **SQL Editor → New query**, paste the contents of
[`frontend/supabase/schema.sql`](frontend/supabase/schema.sql), and run it.

This creates the `deployments` and `deployment_logs` tables with Row-Level Security, so each user can only read their own rows.

If you want to skip email confirmation while testing, turn it off under
**Authentication → Providers → Email → Confirm email**.

### 3. Build and push the build-server image

```bash
cd build_server
docker build -t build-server .
```

Then push it to ECR and point your ECS task definition at it. The task's container
must be named **`Main`** — the API server passes environment overrides to that name.

```bash
aws ecr get-login-password --region ap-southeast-2 \
  | docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-southeast-2.amazonaws.com

docker tag build-server <ACCOUNT_ID>.dkr.ecr.ap-southeast-2.amazonaws.com/build-server:latest
docker push <ACCOUNT_ID>.dkr.ecr.ap-southeast-2.amazonaws.com/build-server:latest
```

### 4. Configure the backend

Copy [`.env.example`](.env.example) to `.env` in the project root and fill it in:

```bash
cp .env.example .env
```

| Variable | Where to find it |
|---|---|
| `REDIS_URL` | Your Redis provider's connection string |
| `AWS_REGION` | e.g. `ap-southeast-2` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | IAM user with ECS + S3 permissions |
| `ECS_CLUSTER_ARN` | ECS console → your cluster |
| `ECS_TASK_DEFINITION_ARN` | ECS console → task definitions |
| `ECS_SUBNETS` | VPC console → subnets (comma-separated) |
| `ECS_SECURITY_GROUPS` | VPC console → security groups |
| `AWS_S3_BUCKET` | Your output bucket name |
| `S3_OUTPUT_BASE_URL` | `https://<bucket>.s3.<region>.amazonaws.com/__outputs` |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` key (**server only**) |

> The service role key bypasses Row-Level Security. Keep it out of the frontend
> and out of version control.

### 5. Configure the frontend

```bash
cp frontend/.env.example frontend/.env.local
```

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → `anon` `public` key |
| `API_SERVER_URL` | `http://localhost:9000` |
| `NEXT_PUBLIC_SOCKET_URL` | `http://localhost:9002` |

### 6. Run it

Three terminals:

```bash
# 1 — API + socket server
cd api-server && npm start

# 2 — reverse proxy
cd s3-reverse-proxy && npm start

# 3 — frontend
cd frontend && npm run dev
```

Open **http://localhost:3000**, sign up, and deploy a repository.

Deployed sites are served at `http://<slug>.localhost:8000`. Chrome and Edge
resolve `*.localhost` automatically; if yours doesn't, add an entry to your
hosts file:

```
127.0.0.1  myproject.localhost
```

---

## What gets built

The build container handles two cases:

- **Has a `build` script** — runs `npm install && npm run build`, then uploads
  whichever of `dist/`, `build/` or `out/` it finds.
- **No build script** — looks for a root `index.html` and uploads the folder as-is.

Anything else fails with a message in the logs.

---

## Deploying to production

**`api-server` and `s3-reverse-proxy` on Render:**

| Setting | api-server | s3-reverse-proxy |
|---|---|---|
| Root Directory | `api-server` | `s3-reverse-proxy` |
| Build Command | `npm install` | `npm install` |
| Start Command | `npm start` | `npm start` |

Both read Render's `PORT`. On a single-port host the API server serves Socket.IO
on the same port, so set the frontend's `NEXT_PUBLIC_SOCKET_URL` to the same URL
as `API_SERVER_URL`.

Set `CORS_ORIGIN` on the API server to your frontend's URL.

**The reverse proxy needs a wildcard domain.** It routes by subdomain, so
`*.onrender.com` won't work — you need a custom domain with a wildcard DNS record
(`*.yourdomain.com`) pointing at the proxy.

**`frontend` on Vercel:** set root directory to `frontend` and add the four
environment variables from step 5.

---

## Troubleshooting

**"Your project's URL and Key are required to create a Supabase client"**
`frontend/.env.local` is missing or the variables aren't prefixed with `NEXT_PUBLIC_`. Restart the dev server after creating it.

**"Could not find the table 'public.deployments'"**
The schema hasn't been run yet — see step 2.

**Build logs never appear**
Check that `REDIS_URL` is identical in the root `.env` and in the ECS task
definition, and that the ECS task's security group allows outbound traffic.

**Deployed site returns 404**
Confirm the files landed in `s3://<bucket>/__outputs/<slug>/` and that
`S3_OUTPUT_BASE_URL` matches your bucket and region.

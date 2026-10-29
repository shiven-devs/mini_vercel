-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).

create table if not exists public.deployments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  git_url     text not null,
  slug        text not null unique,
  url         text,
  status      text not null default 'queued'
              check (status in ('queued', 'ready', 'failed')),
  created_at  timestamptz not null default now()
);

create index if not exists deployments_user_id_created_at_idx
  on public.deployments (user_id, created_at desc);

alter table public.deployments enable row level security;

-- Users can only see and manage their own deployments.
create policy "Users read own deployments"
  on public.deployments for select
  using (auth.uid() = user_id);

create policy "Users insert own deployments"
  on public.deployments for insert
  with check (auth.uid() = user_id);

create policy "Users update own deployments"
  on public.deployments for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete own deployments"
  on public.deployments for delete
  using (auth.uid() = user_id);

-- Build logs, written by api-server with the service role key.
create table if not exists public.deployment_logs (
  id          bigint generated always as identity primary key,
  slug        text not null references public.deployments (slug) on delete cascade,
  log         text not null,
  created_at  timestamptz not null default now()
);

create index if not exists deployment_logs_slug_id_idx
  on public.deployment_logs (slug, id);

alter table public.deployment_logs enable row level security;

-- Users can read logs of their own deployments only.
create policy "Users read own deployment logs"
  on public.deployment_logs for select
  using (
    exists (
      select 1 from public.deployments d
      where d.slug = deployment_logs.slug and d.user_id = auth.uid()
    )
  );

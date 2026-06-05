-- Migration 0001: Teams, Organizations & RBAC foundation
--
-- ADDITIVE and non-destructive: creates new tables, seeds the permission
-- catalogue + system roles, adds nullable org_id/team_id to existing resource
-- tables, and provides a provisioning function. Does NOT enable RLS and does
-- NOT touch existing user_id columns (that is a later, coordinated phase).
--
-- Safe to run on a database that already has schema.sql applied. Idempotent:
-- re-running is a no-op via IF NOT EXISTS / ON CONFLICT.
--
-- See docs/TEAMS_AND_ORGS_PLAN.md for the full design.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy: organizations -> teams -> members
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  created_by  uuid not null references auth.users(id) on delete cascade,
  is_personal boolean not null default false,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists public.organization_members (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member',   -- owner | admin | member
  status     text not null default 'active',   -- active | suspended
  joined_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists organization_members_user_idx
  on public.organization_members(user_id);

create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  created_by  uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);
create index if not exists teams_org_idx on public.teams(org_id);

create table if not exists public.team_members (
  team_id   uuid not null references public.teams(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member',    -- lead | member
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on public.team_members(user_id);

-- ---------------------------------------------------------------------------
-- RBAC: permissions catalogue, roles, mappings, assignments
-- ---------------------------------------------------------------------------

create table if not exists public.permissions (
  key         text primary key,
  description text not null
);

create table if not exists public.roles (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade, -- null = system role
  name        text not null,
  scope       text not null default 'org',     -- org | team
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create table if not exists public.role_permissions (
  role_id        uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

create table if not exists public.role_assignments (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users(id) on delete cascade,
  role_id   uuid not null references public.roles(id) on delete cascade,
  org_id    uuid references public.organizations(id) on delete cascade,
  team_id   uuid references public.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (org_id is not null or team_id is not null)
);
create index if not exists role_assignments_user_idx on public.role_assignments(user_id);
create index if not exists role_assignments_org_idx on public.role_assignments(org_id);

-- ---------------------------------------------------------------------------
-- Invitations (token hash stored; raw token emailed)
-- ---------------------------------------------------------------------------

create table if not exists public.invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  team_id     uuid references public.teams(id) on delete set null,
  email       text not null,
  role        text not null default 'member',
  token_hash  text not null,
  invited_by  uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'pending', -- pending | accepted | revoked | expired
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists invitations_org_idx on public.invitations(org_id);
create index if not exists invitations_email_idx on public.invitations(lower(email));

-- ---------------------------------------------------------------------------
-- Pessimistic resource locks (document editing)
-- ---------------------------------------------------------------------------

create table if not exists public.resource_locks (
  resource_type text not null,                 -- 'document' | 'tabular_review' | ...
  resource_id   uuid not null,
  locked_by     uuid not null references auth.users(id) on delete cascade,
  acquired_at   timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  primary key (resource_type, resource_id)
);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  org_id     uuid references public.organizations(id) on delete cascade,
  actor_id   uuid references auth.users(id) on delete set null,
  action     text not null,
  target     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_org_idx on public.audit_log(org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Add nullable org/team scoping to existing resource tables (additive)
-- ---------------------------------------------------------------------------

alter table public.projects          add column if not exists org_id  uuid references public.organizations(id) on delete cascade;
alter table public.projects          add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.project_subfolders add column if not exists org_id uuid references public.organizations(id) on delete cascade;
alter table public.workflows         add column if not exists org_id  uuid references public.organizations(id) on delete cascade;
alter table public.workflows         add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.tabular_reviews   add column if not exists org_id  uuid references public.organizations(id) on delete cascade;
alter table public.tabular_reviews   add column if not exists team_id uuid references public.teams(id) on delete set null;
alter table public.chats             add column if not exists org_id  uuid references public.organizations(id) on delete cascade;
alter table public.chats             add column if not exists team_id uuid references public.teams(id) on delete set null;

create index if not exists projects_org_idx on public.projects(org_id);
create index if not exists workflows_org_idx on public.workflows(org_id);
create index if not exists tabular_reviews_org_idx on public.tabular_reviews(org_id);
create index if not exists chats_org_idx on public.chats(org_id);

-- ---------------------------------------------------------------------------
-- Seed permission catalogue
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('org.view',        'View organization'),
  ('org.settings',    'Manage organization settings'),
  ('org.delete',      'Delete organization'),
  ('member.view',     'View members'),
  ('member.invite',   'Invite members'),
  ('member.remove',   'Remove members'),
  ('member.role',     'Change member roles'),
  ('team.view',       'View teams'),
  ('team.create',     'Create teams'),
  ('team.update',     'Update teams'),
  ('team.delete',     'Delete teams'),
  ('project.view',    'View projects'),
  ('project.create',  'Create projects'),
  ('project.update',  'Update projects'),
  ('project.delete',  'Delete projects'),
  ('document.view',   'View documents'),
  ('document.edit',   'Edit documents'),
  ('document.delete', 'Delete documents'),
  ('workflow.view',   'View workflows'),
  ('workflow.create', 'Create workflows'),
  ('workflow.update', 'Update workflows'),
  ('workflow.delete', 'Delete workflows'),
  ('review.view',     'View tabular reviews'),
  ('review.create',   'Create tabular reviews'),
  ('review.update',   'Update tabular reviews'),
  ('review.delete',   'Delete tabular reviews'),
  ('chat.view',       'View chats'),
  ('chat.create',     'Create chats'),
  ('audit.view',      'View audit log')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Seed system roles (org-scoped: owner, admin, member; team-scoped: lead, member)
-- ---------------------------------------------------------------------------

insert into public.roles (id, org_id, name, scope, is_system)
values
  ('00000000-0000-0000-0000-0000000000a1', null, 'owner',  'org',  true),
  ('00000000-0000-0000-0000-0000000000a2', null, 'admin',  'org',  true),
  ('00000000-0000-0000-0000-0000000000a3', null, 'member', 'org',  true),
  ('00000000-0000-0000-0000-0000000000b1', null, 'lead',   'team', true),
  ('00000000-0000-0000-0000-0000000000b2', null, 'member', 'team', true)
on conflict (id) do nothing;

-- owner: every permission
insert into public.role_permissions (role_id, permission_key)
select '00000000-0000-0000-0000-0000000000a1', key from public.permissions
on conflict do nothing;

-- admin: everything except org.delete
insert into public.role_permissions (role_id, permission_key)
select '00000000-0000-0000-0000-0000000000a2', key from public.permissions
where key <> 'org.delete'
on conflict do nothing;

-- member: view + create/edit own resource types, no member/team/org management
insert into public.role_permissions (role_id, permission_key)
select '00000000-0000-0000-0000-0000000000a3', key from public.permissions
where key in (
  'org.view','member.view','team.view',
  'project.view','project.create','project.update',
  'document.view','document.edit',
  'workflow.view','workflow.create','workflow.update',
  'review.view','review.create','review.update',
  'chat.view','chat.create'
)
on conflict do nothing;

-- team lead: manage resources within the team
insert into public.role_permissions (role_id, permission_key)
select '00000000-0000-0000-0000-0000000000b1', key from public.permissions
where key in (
  'team.view','team.update','member.view',
  'project.view','project.create','project.update','project.delete',
  'document.view','document.edit','document.delete',
  'workflow.view','workflow.create','workflow.update','workflow.delete',
  'review.view','review.create','review.update','review.delete',
  'chat.view','chat.create'
)
on conflict do nothing;

-- team member: view + create within team
insert into public.role_permissions (role_id, permission_key)
select '00000000-0000-0000-0000-0000000000b2', key from public.permissions
where key in (
  'team.view','project.view','project.create','project.update',
  'document.view','document.edit',
  'workflow.view','workflow.create','workflow.update',
  'review.view','review.create','review.update',
  'chat.view','chat.create'
)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Provisioning function: create a personal org for a user (idempotent)
-- ---------------------------------------------------------------------------

create or replace function public.app_provision_personal_org(p_user uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id  uuid;
  v_team_id uuid;
  v_slug    text;
  v_label   text;
begin
  -- already has a personal org?
  select o.id into v_org_id
  from public.organizations o
  where o.created_by = p_user and o.is_personal = true
  limit 1;
  if v_org_id is not null then
    return v_org_id;
  end if;

  v_label := coalesce(nullif(split_part(coalesce(p_email, ''), '@', 1), ''), 'My') ;
  v_slug  := 'personal-' || replace(p_user::text, '-', '');

  insert into public.organizations (name, slug, created_by, is_personal)
  values (v_label || '''s Organization', v_slug, p_user, true)
  returning id into v_org_id;

  insert into public.teams (org_id, name, is_default, created_by)
  values (v_org_id, 'General', true, p_user)
  returning id into v_team_id;

  insert into public.organization_members (org_id, user_id, role)
  values (v_org_id, p_user, 'owner')
  on conflict do nothing;

  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, p_user, 'lead')
  on conflict do nothing;

  insert into public.role_assignments (user_id, role_id, org_id)
  values (p_user, '00000000-0000-0000-0000-0000000000a1', v_org_id)
  on conflict do nothing;

  return v_org_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: provision a personal org for every existing user
-- ---------------------------------------------------------------------------

do $$
declare
  u record;
begin
  for u in select id, email from auth.users loop
    perform public.app_provision_personal_org(u.id, u.email);
  end loop;
end;
$$;

-- NOTE: assigning existing projects/workflows/etc. to their owner's personal
-- org is deferred to the legacy-sharing migration phase (handled with the
-- user_id text->uuid migration), since user_id is currently text and may hold
-- either a uuid string or an email.

# Plan: Teams, Organizations & Collaboration

Status: **Draft for review** · Owner: Origen Studio · Target: this fork (`OrigenStudio/mike`)

This document plans the addition of multi-tenant organizations, teams, granular
role-based access control (RBAC), shared collaboration with document locking, and
the row-level security (RLS) foundation that makes all of it safe.

It is grounded in two things: Mike's **current** data model, and the **proven
reference implementation** in the `cpatpa/PIP` fork, which already built
workspaces + members + groups/permissions + RLS + SSO on a self-hosted Postgres
stack. We adapt that model to **keep Supabase Auth** (see ADR-1 below).

---

## 1. Scope (locked decisions)

| Decision | Choice | Implication |
|---|---|---|
| Collaboration model | **Shared access + pessimistic document locking** | Multiple members open/edit shared resources; a document being edited is locked (read-only for others) with a TTL + heartbeat. No real-time CRDT co-editing. |
| Tenancy depth | **Organization → Team → resources** | Two levels. Users belong to orgs; teams group members and own resources. |
| Authorization | **Granular RBAC** (permission catalogue) | Named roles bundle capabilities; roles assigned at org and team scope; per-resource grants for fine control. |
| Identity provider | **Keep Supabase Auth** (ADR-1) | No auth rebuild. Roles/permissions live in app tables, enforced by RLS + backend. |
| SSO/SAML | **Deferred** | Supabase supports SAML on paid tiers; add when a customer needs it. No architectural blocker. |

### Out of scope (for now)
- Real-time multi-cursor co-editing (CRDT/OT). The schema is designed so it can
  be layered on later, but it is not part of this plan.
- Cross-organization sharing (a resource shared between two orgs).
- Per-org billing/metering (hooks left in `organizations.settings`, not built).

---

## 2. Current state (what we're building on)

### 2.1 Data model today
- **User-scoped, UUID, FK to `auth.users`:** `user_profiles`, `user_api_keys`.
- **Resource tables, `user_id text`, NO FK:** `projects`, `project_subfolders`,
  `documents` (+ `document_versions`, `document_edits`), `workflows`,
  `hidden_workflows`, `chats` (+ `chat_messages`), `tabular_reviews`
  (+ `tabular_cells`, `tabular_review_chats` + messages).
- **Two inconsistent sharing mechanisms:**
  - `projects.shared_with` and `tabular_reviews.shared_with` — JSONB arrays of emails.
  - `workflow_shares` — a join table (workflow_id × email).

### 2.2 Known debt this plan must absorb
- **Issue #104** — most `user_id` columns are `text` with no referential
  integrity. Upstream **PR #113** migrates them to `uuid` with FK to
  `auth.users`. We fold that in as Phase 0.
- **Issue #144** — **no RLS on any table** (0 policies, confirmed). All access is
  enforced in the Express backend only. This plan closes that gap as its
  foundation, not an afterthought.

---

## 3. Architecture decisions

### ADR-1: Keep Supabase Auth, put RBAC in the database
PIP dropped Supabase for Auth.js + custom JWT + Entra. We do **not** — that's a
multi-week auth rebuild plus a Supabase migration. Instead:
- Identity stays Supabase (`auth.users`, `auth.uid()`).
- Org/team membership and roles live in our tables.
- RLS policies call `auth.uid()` and SECURITY DEFINER helper functions to resolve
  "what orgs/teams/permissions does this user have."
- (Optional, later) mirror a user's org roles into Supabase `app_metadata` custom
  claims for cheaper RLS — not required for v1.

**Consequence:** we reuse PIP's *data model and RLS approach* as a blueprint, but
not its auth code.

### ADR-2: Pessimistic locking, not real-time merge
A document open for editing acquires a lock row with a TTL and a client
heartbeat. Others get read-only + "being edited by X". Locks auto-expire when the
heartbeat stops (tab closed/crashed). Admins (or anyone, after expiry) can take
over. This is far simpler and safer than CRDT and matches the chosen UX.

### ADR-3: One unified access model; retire `shared_with`
The two legacy sharing mechanisms are migrated into org/team membership +
per-resource grants, then removed. No third sharing concept.

---

## 4. Target data model

> SQL below is **illustrative**, not final DDL. Final form ships as numbered
> migrations under `backend/migrations/` (see Phase plan). Types follow PIP's
> proven shapes where sensible.

### 4.1 Tenancy & membership
```sql
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  created_by  uuid not null references auth.users(id),
  settings    jsonb not null default '{}'::jsonb,   -- billing/policy hooks
  created_at  timestamptz not null default now()
);

create table organization_members (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member',         -- owner | admin | member
  status     text not null default 'active',          -- active | suspended
  joined_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table teams (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null,
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (org_id, name)
);

create table team_members (
  team_id   uuid not null references teams(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'member',           -- lead | member
  primary key (team_id, user_id)
);
```

### 4.2 Granular RBAC
```sql
-- Capability catalogue (seeded): e.g. project.create, project.delete,
-- document.edit, member.invite, team.manage, billing.manage, org.settings ...
create table permissions (
  key         text primary key,                       -- 'project.create'
  description text not null
);

-- Named role = a bundle of permissions. System roles seeded; custom roles per org.
create table roles (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references organizations(id) on delete cascade, -- null = system role
  name        text not null,
  is_system   boolean not null default false,
  unique (org_id, name)
);

create table role_permissions (
  role_id        uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);

-- Role assignment at org or team scope.
create table role_assignments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  role_id     uuid not null references roles(id) on delete cascade,
  org_id      uuid references organizations(id) on delete cascade,
  team_id     uuid references teams(id) on delete cascade,
  check (org_id is not null or team_id is not null)
);
```
> Start with system roles `owner`, `admin`, `member` (org) and `lead`, `member`
> (team), each mapped to a sensible permission set. Custom roles are a later
> enhancement but the schema supports them now.

### 4.3 Invitations
```sql
create table invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  team_id     uuid references teams(id) on delete set null,
  email       text not null,
  role        text not null default 'member',
  token_hash  text not null,                          -- store hash, email the raw token
  invited_by  uuid not null references auth.users(id),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
```

### 4.4 Document locking
```sql
create table resource_locks (
  resource_type text not null,                        -- 'document' | 'tabular_review' | ...
  resource_id   uuid not null,
  locked_by     uuid not null references auth.users(id) on delete cascade,
  acquired_at   timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  expires_at    timestamptz not null,                 -- heartbeat_at + grace
  primary key (resource_type, resource_id)
);
```

### 4.5 Audit log (org-admin visibility)
```sql
create table audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid references organizations(id) on delete cascade,
  actor_id    uuid references auth.users(id),
  action      text not null,                          -- 'member.invite', 'project.delete'...
  target      jsonb,
  created_at  timestamptz not null default now()
);
```

### 4.6 Changes to existing resource tables
- Add `org_id uuid references organizations(id)` and `team_id uuid references
  teams(id)` to: `projects`, `workflows`, `tabular_reviews`, `chats`,
  `project_subfolders`. `documents` inherit org/team via their `project_id`.
- Migrate every `user_id text` → `uuid` with FK to `auth.users` (folds in PR #113).
- After backfill (Phase 7), **drop** `projects.shared_with`,
  `tabular_reviews.shared_with`, and the `workflow_shares` table.

---

## 5. Row-Level Security strategy

This is the security backbone (and closes issue #144). Approach mirrors PIP's
`FORCE ROW LEVEL SECURITY` but expressed against `auth.uid()`.

- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY; ... FORCE ROW LEVEL SECURITY;` on
  every app table.
- SECURITY DEFINER helper functions to keep policies DRY and avoid recursive RLS:
  - `app.user_org_ids()` → set of org_ids the caller belongs to.
  - `app.user_team_ids()` → set of team_ids the caller belongs to.
  - `app.has_perm(org_id uuid, perm text)` → boolean (resolves role_assignments → roles → role_permissions).
- Policy pattern per resource table:
  - **SELECT**: `org_id in (select app.user_org_ids())` (optionally team-scoped).
  - **INSERT/UPDATE/DELETE**: membership **and** `app.has_perm(org_id, '<capability>')`.
- The backend continues to enforce checks too (defense in depth) — RLS is the
  backstop, not the only line.

**Critical caveat:** the backend currently uses the Supabase **service-role key**,
which **bypasses RLS**. To make RLS meaningful, the backend must execute
user-scoped queries with the user's JWT (RLS active), reserving the service-role
key for genuinely admin operations. This is a real refactor in
`backend/src/lib/supabase.ts` and every route — accounted for in Phase 2.

---

## 6. Backend surface

New routers (mirroring PIP's `workspaces.ts`, `groups.ts`, `admin.ts`):
- `organizations` — CRUD, settings, switch context.
- `teams` — CRUD within an org.
- `members` — list/add/remove/change-role at org and team scope.
- `invitations` — create (emails token), list pending, accept, revoke.
- `roles` / `permissions` — list catalogue, manage custom roles, assign/unassign.
- `locks` — acquire / heartbeat / release / force-release.

Cross-cutting:
- **Org-context middleware** — resolve "current org" (header `X-Org-Id` or path),
  verify membership, attach to request.
- **Permission middleware** — `requirePerm('project.create')` guards.
- **Rewrite `backend/src/lib/access.ts`** — from `shared_with` containment to
  org/team/permission resolution.
- **Switch to user-JWT Supabase client** for user-scoped queries (RLS active).
- **Email** — wire **Resend** for invitation emails (the previously-deferred
  Resend work becomes a hard dependency here).

---

## 7. Frontend surface

- **Org switcher** in the top nav (current org context persisted).
- **Org settings**: members table, invite modal, role management, teams CRUD,
  audit log view, (billing placeholder).
- **Team pages**: members, resources scoped to team.
- **Resource creation** scoped to current org/team.
- **Permission-gated UI** — hide/disable actions the user's role can't perform.
- **Document lock UX** (ADR-2): show "🔒 being edited by X"; open read-only when
  locked; "take over" after expiry; acquire lock on edit, heartbeat while open,
  release on close.
- **Accept-invitation flow** — landing page that consumes the token, links to
  signup/login if needed, joins the org/team.

Existing components to extend: `PeopleModal.tsx`, `ShareWorkflowModal.tsx`,
`OwnerOnlyModal.tsx`, `ProjectPage.tsx`, `ProjectsOverview.tsx`.

---

## 8. Migration & backfill (zero data loss)

1. **`user_id text → uuid`** with FK (PR #113 approach), after validating every
   existing value is a resolvable user id. Quarantine/repair any that aren't.
2. **Personal org per existing user** — auto-provision "<name>'s Organization",
   make them `owner`, create a default team.
3. **Reassign existing resources** to the owner's personal org/default team.
4. **Translate legacy sharing**:
   - `projects.shared_with` / `tabular_reviews.shared_with` / `workflow_shares`
     emails → resolve to users → add as org members (or per-resource grants).
   - Shared-with emails with **no account** → create **pending invitations**.
5. **Verify** parity (every pre-migration share still has access), then **drop**
   the legacy columns/table.

All backfill ships as idempotent, reversible-where-possible migrations, tested on
a clone of staging data before prod.

---

## 9. Phased delivery

Each phase = one or more PRs through the existing `staging → main` pipeline, with
its own CI + staging soak before promotion.

| Phase | Deliverable | Depends on | Est. |
|---|---|---|---|
| **0. Foundation** | `user_id`→uuid migration; RLS enabled with helper fns + baseline policies; backend switched to user-JWT client. **Standalone security win (closes #144).** | — | 1–1.5 wk |
| **1. Tenancy schema** | orgs/teams/members/roles/permissions/invitations/locks tables; seed system roles + permission catalogue; backfill personal orgs. | 0 | 1 wk |
| **2. Backend core** | org/team/member/role APIs; org-context + permission middleware; rewrite `access.ts`; RLS policies on resource tables. | 1 | 1.5–2 wk |
| **3. Invitations + email** | invitation API; **Resend** wiring; accept flow endpoints. | 2 | 0.5–1 wk |
| **4. Frontend org/team** | org switcher; members/teams/roles settings UI; accept-invite page. | 2,3 | 1.5–2 wk |
| **5. Resource scoping** | attach org/team to resources; scoped queries; permission-gated UI. | 2,4 | 1 wk |
| **6. Document locking** | locks API + heartbeat; editor lock UX. | 2,4 | 1 wk |
| **7. Retire legacy sharing** | migrate `shared_with`/`workflow_shares`; drop them. | 5 | 0.5 wk |
| **8. Hardening & rollout** | cross-tenant isolation tests; RLS/permission matrix tests; lock-race tests; staged prod rollout. | all | 1–1.5 wk |

**Total: ~9–12 weeks for one engineer; ~5–7 weeks for two** working in parallel
(e.g. one on backend/RLS, one on frontend). Phase 0 delivers value (security)
independently and can ship first regardless of the rest.

---

## 10. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Cross-tenant data leak (the whole point) | Critical | RLS + backend checks (belt & braces); a dedicated isolation test suite that asserts user A can never read org B; run it in CI. |
| RLS recursion / performance | High | SECURITY DEFINER helper fns; indexes on `org_id`/membership; consider `app_metadata` claims later. |
| Service-role key bypasses RLS | High | Phase 0 refactor to user-JWT client; audit every remaining service-role use. |
| `user_id text→uuid` migration data loss | High | Validate + quarantine bad values first; test on staging-data clone; reversible migration. |
| Lock races / orphaned locks | Medium | DB primary key on (resource_type,resource_id) makes acquire atomic; TTL + heartbeat auto-expiry; force-release path. |
| Invitation token abuse / email enumeration | Medium | Store token **hash**; short expiry; constant-time responses; rate-limit. |
| Scope creep (custom roles, SSO, billing) | Medium | Schema supports them; explicitly deferred from v1. |
| Resend not yet configured | Low | Becomes a Phase 3 dependency; wire it then. |

---

## 11. Testing strategy

- **Tenant isolation suite** (highest priority): for every resource type, assert a
  member of org A cannot SELECT/UPDATE/DELETE org B's rows — both via API and via
  direct RLS (querying as user B's JWT).
- **Permission matrix**: table-driven tests of (role × capability × resource).
- **Lock concurrency**: simulate two clients acquiring the same lock; assert
  exactly one wins; assert expiry/heartbeat behavior.
- **Migration tests**: run backfill against a snapshot of staging data; assert
  share-parity and zero orphaned resources.
- **RLS regression**: a test that fails if any app table has RLS disabled.

---

## 12. Reference: `cpatpa/PIP` mapping

PIP is AGPL (reuse permitted with attribution). Useful files to study (their
naming → our equivalent):

| PIP | Our equivalent |
|---|---|
| `backend/migrations/0013_workspaces.sql` | orgs/teams + members (§4.1) |
| `backend/migrations/0015/0016_*_members.sql` | per-resource grants |
| `backend/migrations/0024_groups.sql` | roles/permissions catalogue (§4.2) |
| `backend/migrations/0011_*rls*.sql` | RLS strategy (§5) |
| `backend/migrations/0014_workspace_links.sql` | `org_id`/`team_id` on resources (§4.6) |
| `backend/src/routes/workspaces.ts`, `groups.ts`, `admin.ts` | backend routers (§6) |
| `backend/src/lib/permissions.ts`, `projectMembers.ts` | access rewrite (§6) |
| `frontend/.../workspaces/`, `admin/` | frontend (§7) |

We diverge from PIP only at the identity layer (Supabase Auth vs their Auth.js +
Entra), per ADR-1.

---

## 13. Open questions for sign-off

1. Default permission sets for system roles (owner/admin/member, lead/member) —
   draft a matrix in Phase 1.
2. Can a user belong to **multiple organizations**? (Assumed **yes** — standard
   B2B SaaS. Confirm.)
3. Lock TTL + heartbeat interval defaults (proposed: 2-min TTL, 30-s heartbeat).
4. Custom roles in v1 or deferred? (Schema supports; proposed **deferred**.)
5. Audit log retention + who can view (proposed: org admins, 1 year).

/**
 * Tenancy & RBAC helpers.
 *
 * Centralizes "what orgs/teams does this user belong to" and "does this user
 * have permission X in org Y". Every org-scoped route resolves access through
 * these helpers + the loadOrgContext / requirePerm middleware so the rules
 * live in one place.
 *
 * NOTE: until RLS is enabled (later phase), the backend is the only access
 * boundary. These checks are therefore load-bearing — change with care.
 */

import { Request, Response, NextFunction } from "express";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

// System role ids seeded in migration 0001.
export const SYSTEM_ROLE_IDS = {
  org: {
    owner: "00000000-0000-0000-0000-0000000000a1",
    admin: "00000000-0000-0000-0000-0000000000a2",
    member: "00000000-0000-0000-0000-0000000000a3",
  },
  team: {
    lead: "00000000-0000-0000-0000-0000000000b1",
    member: "00000000-0000-0000-0000-0000000000b2",
  },
} as const;

export type OrgRole = "owner" | "admin" | "member";

export function orgRoleId(role: OrgRole): string {
  return SYSTEM_ROLE_IDS.org[role] ?? SYSTEM_ROLE_IDS.org.member;
}

export interface Membership {
  org_id: string;
  role: OrgRole;
  status: string;
}

/** Ensure the user has a personal org; returns its id. */
export async function ensurePersonalOrg(
  userId: string,
  email: string | null | undefined,
  db: Db,
): Promise<string | null> {
  const { data, error } = await db.rpc("app_provision_personal_org", {
    p_user: userId,
    p_email: email ?? "",
  });
  if (error) return null;
  return (data as string) ?? null;
}

/** Orgs the user is an active member of, with their role. */
export async function listMemberships(
  userId: string,
  db: Db,
): Promise<Membership[]> {
  const { data } = await db
    .from("organization_members")
    .select("org_id, role, status")
    .eq("user_id", userId)
    .eq("status", "active");
  return (data ?? []) as Membership[];
}

/** The user's membership in one org, or null. */
export async function getMembership(
  orgId: string,
  userId: string,
  db: Db,
): Promise<Membership | null> {
  const { data } = await db
    .from("organization_members")
    .select("org_id, role, status")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  const m = data as Membership;
  return m.status === "active" ? m : null;
}

/** Resolve the set of permission keys a user holds in an org. */
export async function getPermissions(
  orgId: string,
  userId: string,
  db: Db,
): Promise<Set<string>> {
  const { data: assignments } = await db
    .from("role_assignments")
    .select("role_id")
    .eq("user_id", userId)
    .eq("org_id", orgId);
  const roleIds = (assignments ?? []).map(
    (a) => (a as { role_id: string }).role_id,
  );
  if (roleIds.length === 0) return new Set();
  const { data: perms } = await db
    .from("role_permissions")
    .select("permission_key")
    .in("role_id", roleIds);
  return new Set(
    (perms ?? []).map((p) => (p as { permission_key: string }).permission_key),
  );
}

/**
 * Resolve the "active organization" for a resource operation:
 *   - the X-Org-Id header if present AND the user is an active member, else
 *   - the user's personal org (auto-provisioned if missing).
 * Also returns the org's default team id. Used by resource routes to stamp
 * org_id/team_id on creates and to scope listings.
 */
export async function resolveActiveOrg(
  req: Request,
  userId: string,
  email: string | null | undefined,
  db: Db,
): Promise<{ orgId: string; teamId: string | null } | null> {
  const headerOrg = req.header("x-org-id") ?? undefined;
  let orgId: string | null = null;
  if (headerOrg) {
    const m = await getMembership(headerOrg, userId, db);
    if (m) orgId = headerOrg;
  }
  if (!orgId) {
    orgId = await ensurePersonalOrg(userId, email, db);
  }
  if (!orgId) return null;
  const { data: team } = await db
    .from("teams")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_default", true)
    .maybeSingle();
  return { orgId, teamId: (team as { id: string } | null)?.id ?? null };
}

/** Org ids the user can access (active membership). Convenience wrapper. */
export async function accessibleOrgIds(
  userId: string,
  db: Db,
): Promise<string[]> {
  const m = await listMemberships(userId, db);
  return m.map((x) => x.org_id);
}

/** Write an audit row (best-effort; never throws into the request path). */
export async function writeAudit(
  orgId: string | null,
  actorId: string | null,
  action: string,
  target: unknown,
  db: Db,
): Promise<void> {
  try {
    await db.from("audit_log").insert({
      org_id: orgId,
      actor_id: actorId,
      action,
      target: target ?? null,
    });
  } catch {
    /* swallow */
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Resolve org context from req.params.orgId (or X-Org-Id header), verify the
 * caller is an active member, and attach { orgId, orgRole, orgPerms } to
 * res.locals. Must run after requireAuth.
 */
export async function loadOrgContext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = res.locals.userId as string;
  const orgId =
    (req.params.orgId as string | undefined) ??
    (req.header("x-org-id") ?? undefined);
  if (!orgId) {
    res.status(400).json({ detail: "Missing organization id" });
    return;
  }
  const db = createServerSupabase();
  const membership = await getMembership(orgId, userId, db);
  if (!membership) {
    // 404 (not 403) so we don't leak existence of orgs the user can't see.
    res.status(404).json({ detail: "Organization not found" });
    return;
  }
  res.locals.orgId = orgId;
  res.locals.orgRole = membership.role;
  res.locals.orgPerms = await getPermissions(orgId, userId, db);
  next();
}

/** Guard a route on a specific permission. Run after loadOrgContext. */
export function requirePerm(perm: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const perms = res.locals.orgPerms as Set<string> | undefined;
    if (!perms || !perms.has(perm)) {
      res.status(403).json({ detail: `Missing permission: ${perm}` });
      return;
    }
    next();
  };
}

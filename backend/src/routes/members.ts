import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  loadOrgContext,
  requirePerm,
  orgRoleId,
  writeAudit,
  type OrgRole,
} from "../lib/tenancy";

export const membersRouter = Router({ mergeParams: true });
membersRouter.use(requireAuth, loadOrgContext);

const VALID_ROLES: OrgRole[] = ["owner", "admin", "member"];

// GET /organizations/:orgId/members
membersRouter.get("/", requirePerm("member.view"), async (_req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const { data: members, error } = await db
    .from("organization_members")
    .select("user_id, role, status, joined_at")
    .eq("org_id", orgId);
  if (error) return void res.status(500).json({ detail: error.message });

  // Resolve emails (small lists; best-effort).
  const enriched = await Promise.all(
    (members ?? []).map(async (m) => {
      const row = m as { user_id: string; role: string; status: string; joined_at: string };
      let email: string | null = null;
      try {
        const { data } = await db.auth.admin.getUserById(row.user_id);
        email = data.user?.email ?? null;
      } catch {
        /* ignore */
      }
      return { ...row, email };
    }),
  );
  res.json(enriched);
});

// PATCH /organizations/:orgId/members/:userId — change role
membersRouter.patch(
  "/:userId",
  requirePerm("member.role"),
  async (req, res) => {
    const db = createServerSupabase();
    const orgId = res.locals.orgId as string;
    const targetUser = req.params.userId;
    const { role } = req.body as { role?: OrgRole };
    if (!role || !VALID_ROLES.includes(role)) {
      return void res.status(400).json({ detail: "valid role required" });
    }
    // Guard: don't allow demoting the last owner.
    if (role !== "owner") {
      const { data: owners } = await db
        .from("organization_members")
        .select("user_id")
        .eq("org_id", orgId)
        .eq("role", "owner");
      const ownerIds = (owners ?? []).map((o) => (o as { user_id: string }).user_id);
      if (ownerIds.length === 1 && ownerIds[0] === targetUser) {
        return void res
          .status(400)
          .json({ detail: "Cannot demote the last owner" });
      }
    }
    const { error } = await db
      .from("organization_members")
      .update({ role })
      .eq("org_id", orgId)
      .eq("user_id", targetUser);
    if (error) return void res.status(500).json({ detail: error.message });

    // Keep role_assignments in sync (drop org-scoped system roles, add new).
    await db
      .from("role_assignments")
      .delete()
      .eq("org_id", orgId)
      .eq("user_id", targetUser)
      .in("role_id", VALID_ROLES.map(orgRoleId));
    await db
      .from("role_assignments")
      .insert({ user_id: targetUser, role_id: orgRoleId(role), org_id: orgId });
    await writeAudit(orgId, res.locals.userId as string, "member.role", {
      targetUser,
      role,
    }, db);
    res.json({ ok: true });
  },
);

// DELETE /organizations/:orgId/members/:userId
membersRouter.delete(
  "/:userId",
  requirePerm("member.remove"),
  async (req, res) => {
    const db = createServerSupabase();
    const orgId = res.locals.orgId as string;
    const targetUser = req.params.userId;
    const { data: target } = await db
      .from("organization_members")
      .select("role")
      .eq("org_id", orgId)
      .eq("user_id", targetUser)
      .maybeSingle();
    if (!target) return void res.status(404).json({ detail: "Member not found" });
    if ((target as { role: string }).role === "owner") {
      const { data: owners } = await db
        .from("organization_members")
        .select("user_id")
        .eq("org_id", orgId)
        .eq("role", "owner");
      if ((owners ?? []).length <= 1) {
        return void res
          .status(400)
          .json({ detail: "Cannot remove the last owner" });
      }
    }
    await db
      .from("role_assignments")
      .delete()
      .eq("org_id", orgId)
      .eq("user_id", targetUser);
    const { error } = await db
      .from("organization_members")
      .delete()
      .eq("org_id", orgId)
      .eq("user_id", targetUser);
    if (error) return void res.status(500).json({ detail: error.message });
    await writeAudit(orgId, res.locals.userId as string, "member.remove", {
      targetUser,
    }, db);
    res.status(204).end();
  },
);

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  listMemberships,
  ensurePersonalOrg,
  loadOrgContext,
  requirePerm,
  orgRoleId,
  writeAudit,
} from "../lib/tenancy";

export const organizationsRouter = Router();

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

// GET /organizations — list my orgs (auto-provision a personal one if none)
organizationsRouter.get("/", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();

  let memberships = await listMemberships(userId, db);
  if (memberships.length === 0) {
    await ensurePersonalOrg(userId, userEmail, db);
    memberships = await listMemberships(userId, db);
  }
  const orgIds = memberships.map((m) => m.org_id);
  const { data: orgs } = await db
    .from("organizations")
    .select("*")
    .in("id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"]);
  const roleByOrg = new Map(memberships.map((m) => [m.org_id, m.role]));
  const result = (orgs ?? []).map((o) => ({
    ...(o as Record<string, unknown>),
    my_role: roleByOrg.get((o as { id: string }).id) ?? null,
  }));
  res.json(result);
});

// POST /organizations — create a new organization
organizationsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    return void res.status(400).json({ detail: "name is required" });
  }
  const db = createServerSupabase();
  const slug = `${slugify(name)}-${Math.abs(hashCode(userId + name)).toString(36)}`;

  const { data: org, error } = await db
    .from("organizations")
    .insert({ name: name.trim(), slug, created_by: userId, is_personal: false })
    .select()
    .single();
  if (error || !org) {
    return void res.status(500).json({ detail: error?.message ?? "create failed" });
  }
  const orgId = (org as { id: string }).id;

  await db.from("teams").insert({
    org_id: orgId,
    name: "General",
    is_default: true,
    created_by: userId,
  });
  await db
    .from("organization_members")
    .insert({ org_id: orgId, user_id: userId, role: "owner" });
  await db
    .from("role_assignments")
    .insert({ user_id: userId, role_id: orgRoleId("owner"), org_id: orgId });
  await writeAudit(orgId, userId, "org.create", { name: name.trim() }, db);

  res.status(201).json(org);
});

// GET /organizations/:orgId
organizationsRouter.get(
  "/:orgId",
  requireAuth,
  loadOrgContext,
  async (_req, res) => {
    const db = createServerSupabase();
    const orgId = res.locals.orgId as string;
    const { data: org } = await db
      .from("organizations")
      .select("*")
      .eq("id", orgId)
      .single();
    res.json({ ...(org as Record<string, unknown>), my_role: res.locals.orgRole });
  },
);

// PATCH /organizations/:orgId — settings/name (requires org.settings)
organizationsRouter.patch(
  "/:orgId",
  requireAuth,
  loadOrgContext,
  requirePerm("org.settings"),
  async (req, res) => {
    const db = createServerSupabase();
    const orgId = res.locals.orgId as string;
    const { name, settings } = req.body as {
      name?: string;
      settings?: Record<string, unknown>;
    };
    const patch: Record<string, unknown> = {};
    if (typeof name === "string" && name.trim()) patch.name = name.trim();
    if (settings && typeof settings === "object") patch.settings = settings;
    if (Object.keys(patch).length === 0) {
      return void res.status(400).json({ detail: "nothing to update" });
    }
    const { data, error } = await db
      .from("organizations")
      .update(patch)
      .eq("id", orgId)
      .select()
      .single();
    if (error) return void res.status(500).json({ detail: error.message });
    await writeAudit(orgId, res.locals.userId as string, "org.update", patch, db);
    res.json(data);
  },
);

// DELETE /organizations/:orgId (requires org.delete; cannot delete personal)
organizationsRouter.delete(
  "/:orgId",
  requireAuth,
  loadOrgContext,
  requirePerm("org.delete"),
  async (_req, res) => {
    const db = createServerSupabase();
    const orgId = res.locals.orgId as string;
    const { data: org } = await db
      .from("organizations")
      .select("is_personal")
      .eq("id", orgId)
      .single();
    if ((org as { is_personal: boolean } | null)?.is_personal) {
      return void res
        .status(400)
        .json({ detail: "Cannot delete a personal organization" });
    }
    const { error } = await db.from("organizations").delete().eq("id", orgId);
    if (error) return void res.status(500).json({ detail: error.message });
    await writeAudit(null, res.locals.userId as string, "org.delete", { orgId }, db);
    res.status(204).end();
  },
);

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

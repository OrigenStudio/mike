import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { loadOrgContext, requirePerm } from "../lib/tenancy";

export const rolesRouter = Router({ mergeParams: true });
rolesRouter.use(requireAuth, loadOrgContext);

// GET /organizations/:orgId/roles — system + org-custom roles with permissions
rolesRouter.get("/", requirePerm("org.view"), async (_req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const { data: roles } = await db
    .from("roles")
    .select("id, name, scope, is_system, org_id")
    .or(`is_system.eq.true,org_id.eq.${orgId}`);
  const ids = (roles ?? []).map((r) => (r as { id: string }).id);
  const { data: rp } = await db
    .from("role_permissions")
    .select("role_id, permission_key")
    .in("role_id", ids.length ? ids : ["x"]);
  const permsByRole = new Map<string, string[]>();
  for (const row of (rp ?? []) as { role_id: string; permission_key: string }[]) {
    const arr = permsByRole.get(row.role_id) ?? [];
    arr.push(row.permission_key);
    permsByRole.set(row.role_id, arr);
  }
  res.json(
    (roles ?? []).map((r) => {
      const role = r as { id: string };
      return { ...(r as Record<string, unknown>), permissions: permsByRole.get(role.id) ?? [] };
    }),
  );
});

// GET /organizations/:orgId/roles/catalogue — full permission catalogue
rolesRouter.get("/catalogue", requirePerm("org.view"), async (_req, res) => {
  const db = createServerSupabase();
  const { data } = await db
    .from("permissions")
    .select("key, description")
    .order("key");
  res.json(data ?? []);
});

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { loadOrgContext, requirePerm, writeAudit } from "../lib/tenancy";

// mergeParams so :orgId from the mount path is visible.
export const teamsRouter = Router({ mergeParams: true });

teamsRouter.use(requireAuth, loadOrgContext);

// GET /organizations/:orgId/teams
teamsRouter.get("/", requirePerm("team.view"), async (_req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const { data, error } = await db
    .from("teams")
    .select("*")
    .eq("org_id", orgId)
    .order("created_at", { ascending: true });
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data ?? []);
});

// POST /organizations/:orgId/teams
teamsRouter.post("/", requirePerm("team.create"), async (req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const userId = res.locals.userId as string;
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    return void res.status(400).json({ detail: "name is required" });
  }
  const { data, error } = await db
    .from("teams")
    .insert({ org_id: orgId, name: name.trim(), created_by: userId })
    .select()
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  // creator joins as lead
  await db
    .from("team_members")
    .insert({ team_id: (data as { id: string }).id, user_id: userId, role: "lead" });
  await writeAudit(orgId, userId, "team.create", { name: name.trim() }, db);
  res.status(201).json(data);
});

// PATCH /organizations/:orgId/teams/:teamId
teamsRouter.patch("/:teamId", requirePerm("team.update"), async (req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const teamId = req.params.teamId;
  const { name } = req.body as { name?: string };
  if (!name || !name.trim()) {
    return void res.status(400).json({ detail: "name is required" });
  }
  const { data, error } = await db
    .from("teams")
    .update({ name: name.trim() })
    .eq("id", teamId)
    .eq("org_id", orgId)
    .select()
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.json(data);
});

// DELETE /organizations/:orgId/teams/:teamId (cannot delete default)
teamsRouter.delete("/:teamId", requirePerm("team.delete"), async (req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const teamId = req.params.teamId;
  const { data: team } = await db
    .from("teams")
    .select("is_default")
    .eq("id", teamId)
    .eq("org_id", orgId)
    .single();
  if (!team) return void res.status(404).json({ detail: "Team not found" });
  if ((team as { is_default: boolean }).is_default) {
    return void res.status(400).json({ detail: "Cannot delete the default team" });
  }
  const { error } = await db
    .from("teams")
    .delete()
    .eq("id", teamId)
    .eq("org_id", orgId);
  if (error) return void res.status(500).json({ detail: error.message });
  await writeAudit(orgId, res.locals.userId as string, "team.delete", { teamId }, db);
  res.status(204).end();
});

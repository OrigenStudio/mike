-- Migration 0003: Backfill org_id/team_id on existing resources
--
-- Assigns every existing project/workflow/tabular_review/chat/subfolder to its
-- owner's PERSONAL organization + default team. This must run before listing
-- is scoped by org (migration is paired with the resource-scoping backend
-- change) so existing data doesn't disappear from users' views.
--
-- Owner is identified by user_id (text) == auth.users.id::text, which is how
-- the app stores ownership today.
--
-- Idempotent: only fills rows where org_id is still null.

do $$
declare
  r record;
begin
  for r in
    select o.id as org_id, t.id as team_id, o.created_by as uid
    from public.organizations o
    join public.teams t on t.org_id = o.id and t.is_default
    where o.is_personal
  loop
    update public.projects
      set org_id = r.org_id, team_id = coalesce(team_id, r.team_id)
      where user_id = r.uid::text and org_id is null;
    update public.workflows
      set org_id = r.org_id, team_id = coalesce(team_id, r.team_id)
      where user_id = r.uid::text and org_id is null;
    update public.tabular_reviews
      set org_id = r.org_id, team_id = coalesce(team_id, r.team_id)
      where user_id = r.uid::text and org_id is null;
    update public.chats
      set org_id = r.org_id, team_id = coalesce(team_id, r.team_id)
      where user_id = r.uid::text and org_id is null;
    update public.project_subfolders
      set org_id = r.org_id
      where user_id = r.uid::text and org_id is null;
  end loop;
end;
$$;

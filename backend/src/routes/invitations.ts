import { Router } from "express";
import { createHash, randomBytes } from "crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  loadOrgContext,
  requirePerm,
  orgRoleId,
  writeAudit,
  type OrgRole,
} from "../lib/tenancy";
import { sendEmail, emailEnabled } from "../lib/email";

const INVITE_TTL_DAYS = 7;
const VALID_ROLES: OrgRole[] = ["owner", "admin", "member"];

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ---- Org-scoped invitation management -------------------------------------
// Mounted at /organizations/:orgId/invitations
export const invitationsRouter = Router({ mergeParams: true });
invitationsRouter.use(requireAuth, loadOrgContext);

// POST / — create an invitation
invitationsRouter.post("/", requirePerm("member.invite"), async (req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const inviter = res.locals.userId as string;
  const { email, role, team_id } = req.body as {
    email?: string;
    role?: OrgRole;
    team_id?: string | null;
  };
  if (!email || !email.includes("@")) {
    return void res.status(400).json({ detail: "valid email required" });
  }
  const useRole: OrgRole = role && VALID_ROLES.includes(role) ? role : "member";
  const rawToken = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();

  const { data: inv, error } = await db
    .from("invitations")
    .insert({
      org_id: orgId,
      team_id: team_id ?? null,
      email: email.toLowerCase().trim(),
      role: useRole,
      token_hash: hashToken(rawToken),
      invited_by: inviter,
      expires_at: expires,
    })
    .select("id, email, role, status, expires_at, created_at")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });

  const acceptUrl = `${process.env.FRONTEND_URL ?? ""}/invite/accept?token=${rawToken}`;
  const { data: org } = await db
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .single();
  const orgName = (org as { name: string } | null)?.name ?? "an organization";

  const mail = await sendEmail({
    to: email,
    subject: `You've been invited to ${orgName} on Mike`,
    html: `<p>You've been invited to join <strong>${orgName}</strong> on Mike.</p>
           <p><a href="${acceptUrl}">Accept the invitation</a> (expires in ${INVITE_TTL_DAYS} days).</p>`,
  });

  await writeAudit(orgId, inviter, "member.invite", { email, role: useRole }, db);

  // When email isn't wired (staging), return the accept URL so the inviter can
  // share it manually. Never returned once Resend is configured.
  res.status(201).json({
    ...inv,
    email_sent: mail.sent,
    accept_url: emailEnabled() ? undefined : acceptUrl,
  });
});

// GET / — list pending invitations
invitationsRouter.get("/", requirePerm("member.view"), async (_req, res) => {
  const db = createServerSupabase();
  const orgId = res.locals.orgId as string;
  const { data } = await db
    .from("invitations")
    .select("id, email, role, status, expires_at, created_at")
    .eq("org_id", orgId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  res.json(data ?? []);
});

// DELETE /:invId — revoke
invitationsRouter.delete(
  "/:invId",
  requirePerm("member.invite"),
  async (req, res) => {
    const db = createServerSupabase();
    const orgId = res.locals.orgId as string;
    const { error } = await db
      .from("invitations")
      .update({ status: "revoked" })
      .eq("id", req.params.invId)
      .eq("org_id", orgId)
      .eq("status", "pending");
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).end();
  },
);

// ---- Acceptance (mounted at /invitations) ---------------------------------
export const invitationAcceptRouter = Router();

// POST /invitations/accept { token }
invitationAcceptRouter.post("/accept", requireAuth, async (req, res) => {
  const db = createServerSupabase();
  const userId = res.locals.userId as string;
  const userEmail = (res.locals.userEmail as string | undefined)?.toLowerCase();
  const { token } = req.body as { token?: string };
  if (!token) return void res.status(400).json({ detail: "token required" });

  const { data: inv } = await db
    .from("invitations")
    .select("*")
    .eq("token_hash", hashToken(token))
    .eq("status", "pending")
    .maybeSingle();
  if (!inv) return void res.status(404).json({ detail: "Invitation not found" });
  const invite = inv as {
    id: string;
    org_id: string;
    team_id: string | null;
    email: string;
    role: OrgRole;
    expires_at: string;
  };
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    await db.from("invitations").update({ status: "expired" }).eq("id", invite.id);
    return void res.status(410).json({ detail: "Invitation expired" });
  }
  if (userEmail && invite.email.toLowerCase() !== userEmail) {
    return void res
      .status(403)
      .json({ detail: "This invitation was sent to a different email" });
  }

  await db
    .from("organization_members")
    .upsert(
      { org_id: invite.org_id, user_id: userId, role: invite.role },
      { onConflict: "org_id,user_id" },
    );
  await db
    .from("role_assignments")
    .insert({ user_id: userId, role_id: orgRoleId(invite.role), org_id: invite.org_id });
  if (invite.team_id) {
    await db
      .from("team_members")
      .upsert(
        { team_id: invite.team_id, user_id: userId, role: "member" },
        { onConflict: "team_id,user_id" },
      );
  }
  await db
    .from("invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .eq("id", invite.id);
  await writeAudit(invite.org_id, userId, "member.join", { via: "invite" }, db);

  res.json({ ok: true, org_id: invite.org_id });
});

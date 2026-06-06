/**
 * Organizations / teams / members / invitations / roles API client.
 * Reuses mikeApi's apiRequest (attaches the Supabase auth token).
 */
import { apiRequest } from "./mikeApi";

export type OrgRole = "owner" | "admin" | "member";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  is_personal: boolean;
  settings: Record<string, unknown>;
  created_at: string;
  my_role?: OrgRole | null;
}

export interface OrgMember {
  user_id: string;
  email: string | null;
  role: OrgRole;
  status: string;
  joined_at: string;
}

export interface Team {
  id: string;
  org_id: string;
  name: string;
  is_default: boolean;
  created_at: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  status: string;
  expires_at: string;
  created_at: string;
  // present only when SMTP isn't configured (staging) so the inviter can share manually
  accept_url?: string;
  email_sent?: boolean;
}

export interface RoleInfo {
  id: string;
  name: string;
  scope: string;
  is_system: boolean;
  permissions: string[];
}

// --- Organizations ---------------------------------------------------------

export function listOrganizations(): Promise<Organization[]> {
  return apiRequest<Organization[]>("/organizations");
}

export function createOrganization(name: string): Promise<Organization> {
  return apiRequest<Organization>("/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function updateOrganization(
  orgId: string,
  patch: { name?: string; settings?: Record<string, unknown> },
): Promise<Organization> {
  return apiRequest<Organization>(`/organizations/${orgId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteOrganization(orgId: string): Promise<void> {
  return apiRequest<void>(`/organizations/${orgId}`, { method: "DELETE" });
}

// --- Members ---------------------------------------------------------------

export function listMembers(orgId: string): Promise<OrgMember[]> {
  return apiRequest<OrgMember[]>(`/organizations/${orgId}/members`);
}

export function changeMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  return apiRequest<void>(`/organizations/${orgId}/members/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export function removeMember(orgId: string, userId: string): Promise<void> {
  return apiRequest<void>(`/organizations/${orgId}/members/${userId}`, {
    method: "DELETE",
  });
}

// --- Teams -----------------------------------------------------------------

export function listTeams(orgId: string): Promise<Team[]> {
  return apiRequest<Team[]>(`/organizations/${orgId}/teams`);
}

export function createTeam(orgId: string, name: string): Promise<Team> {
  return apiRequest<Team>(`/organizations/${orgId}/teams`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export function deleteTeam(orgId: string, teamId: string): Promise<void> {
  return apiRequest<void>(`/organizations/${orgId}/teams/${teamId}`, {
    method: "DELETE",
  });
}

// --- Invitations -----------------------------------------------------------

export function listInvitations(orgId: string): Promise<Invitation[]> {
  return apiRequest<Invitation[]>(`/organizations/${orgId}/invitations`);
}

export function createInvitation(
  orgId: string,
  email: string,
  role: OrgRole,
): Promise<Invitation> {
  return apiRequest<Invitation>(`/organizations/${orgId}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
}

export function revokeInvitation(orgId: string, invId: string): Promise<void> {
  return apiRequest<void>(`/organizations/${orgId}/invitations/${invId}`, {
    method: "DELETE",
  });
}

export function acceptInvitation(token: string): Promise<{ ok: boolean; org_id: string }> {
  return apiRequest<{ ok: boolean; org_id: string }>("/invitations/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

// --- Roles -----------------------------------------------------------------

export function listRoles(orgId: string): Promise<RoleInfo[]> {
  return apiRequest<RoleInfo[]>(`/organizations/${orgId}/roles`);
}

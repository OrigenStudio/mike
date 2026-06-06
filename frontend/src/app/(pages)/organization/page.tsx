"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Building2,
  ChevronDown,
  Plus,
  Trash2,
  UserPlus,
  Loader2,
  Check,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/contexts/AuthContext";
import {
  listOrganizations,
  createOrganization,
  listMembers,
  changeMemberRole,
  removeMember,
  listTeams,
  createTeam,
  deleteTeam,
  listInvitations,
  createInvitation,
  revokeInvitation,
  type Organization,
  type OrgMember,
  type Team,
  type Invitation,
  type OrgRole,
} from "@/app/lib/orgApi";

const ROLES: OrgRole[] = ["owner", "admin", "member"];

export default function OrganizationPage() {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [current, setCurrent] = useState<Organization | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState("");
  const [newOrg, setNewOrg] = useState("");

  const canManage = current?.my_role === "owner" || current?.my_role === "admin";

  const loadOrgDetail = useCallback(async (org: Organization) => {
    try {
      const [m, t, inv] = await Promise.all([
        listMembers(org.id).catch(() => []),
        listTeams(org.id).catch(() => []),
        listInvitations(org.id).catch(() => []),
      ]);
      setMembers(m);
      setTeams(t);
      setInvites(inv);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load organization");
    }
  }, []);

  const loadOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listOrganizations();
      setOrgs(list);
      const cur = current
        ? list.find((o) => o.id === current.id) ?? list[0]
        : list[0];
      setCurrent(cur ?? null);
      if (cur) await loadOrgDetail(cur);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load organizations");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOrgDetail]);

  useEffect(() => {
    loadOrgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function switchTo(org: Organization) {
    setCurrent(org);
    setSwitcherOpen(false);
    setLastInviteUrl(null);
    setError(null);
    await loadOrgDetail(org);
  }

  async function handleCreateOrg() {
    if (!newOrg.trim()) return;
    setBusy(true);
    try {
      const org = await createOrganization(newOrg.trim());
      setNewOrg("");
      await loadOrgs();
      await switchTo({ ...org, my_role: "owner" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite() {
    if (!current || !inviteEmail.includes("@")) return;
    setBusy(true);
    setLastInviteUrl(null);
    try {
      const inv = await createInvitation(current.id, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      if (inv.accept_url) setLastInviteUrl(inv.accept_url);
      await loadOrgDetail(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRoleChange(m: OrgMember, role: OrgRole) {
    if (!current) return;
    try {
      await changeMemberRole(current.id, m.user_id, role);
      await loadOrgDetail(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Role change failed");
    }
  }

  async function handleRemove(m: OrgMember) {
    if (!current) return;
    try {
      await removeMember(current.id, m.user_id);
      await loadOrgDetail(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    }
  }

  async function handleCreateTeam() {
    if (!current || !newTeam.trim()) return;
    setBusy(true);
    try {
      await createTeam(current.id, newTeam.trim());
      setNewTeam("");
      await loadOrgDetail(current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create team failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* Switcher */}
      <div className="relative mb-8">
        <button
          onClick={() => setSwitcherOpen((v) => !v)}
          className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-left shadow-sm hover:bg-gray-50"
        >
          <Building2 className="h-5 w-5 text-gray-500" />
          <span className="font-semibold text-gray-900">
            {current?.name ?? "No organization"}
          </span>
          {current?.is_personal && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
              personal
            </span>
          )}
          <ChevronDown className="h-4 w-4 text-gray-400" />
        </button>
        {switcherOpen && (
          <div className="absolute z-10 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-1 shadow-lg">
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => switchTo(o)}
                className="flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-gray-400" />
                  {o.name}
                </span>
                {o.id === current?.id && <Check className="h-4 w-4 text-green-600" />}
              </button>
            ))}
            <div className="mt-1 flex items-center gap-1 border-t border-gray-100 p-1">
              <Input
                value={newOrg}
                onChange={(e) => setNewOrg(e.target.value)}
                placeholder="New organization name"
                className="h-8 text-sm"
              />
              <Button size="sm" onClick={handleCreateOrg} disabled={busy || !newOrg.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        {current && (
          <p className="mt-1 text-xs text-gray-500">
            Your role: <span className="font-medium">{current.my_role}</span>
          </p>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Members */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Members</h2>
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-900">
                    {m.email ?? m.user_id.slice(0, 8)}
                    {m.user_id === user?.id && (
                      <span className="ml-1 text-xs text-gray-400">(you)</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {canManage && m.user_id !== user?.id ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m, e.target.value as OrgRole)}
                        className="rounded border border-gray-200 px-2 py-1 text-sm"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="capitalize text-gray-700">{m.role}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {canManage && m.user_id !== user?.id && (
                      <button
                        onClick={() => handleRemove(m)}
                        className="text-gray-400 hover:text-red-600"
                        title="Remove member"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canManage && (
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="invite@example.com"
              className="max-w-xs"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as OrgRole)}
              className="rounded border border-gray-200 px-2 py-2 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button onClick={handleInvite} disabled={busy || !inviteEmail.includes("@")}>
              <UserPlus className="mr-1 h-4 w-4" /> Invite
            </Button>
          </div>
        )}

        {lastInviteUrl && (
          <div className="mt-2 flex items-center gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <span className="truncate">
              Email isn&apos;t configured — share this link: {lastInviteUrl}
            </span>
            <button
              onClick={() => navigator.clipboard?.writeText(lastInviteUrl)}
              className="shrink-0 hover:text-amber-950"
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </section>

      {/* Pending invitations */}
      {canManage && invites.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-gray-900">Pending invitations</h2>
          <div className="rounded-lg border border-gray-200">
            {invites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between border-b border-gray-100 px-4 py-2 text-sm last:border-b-0"
              >
                <span className="text-gray-800">
                  {inv.email} · <span className="capitalize text-gray-500">{inv.role}</span>
                </span>
                <button
                  onClick={() => current && revokeInvitation(current.id, inv.id).then(() => loadOrgDetail(current))}
                  className="text-gray-400 hover:text-red-600"
                  title="Revoke"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Teams */}
      <section>
        <h2 className="mb-3 text-lg font-semibold text-gray-900">Teams</h2>
        <div className="rounded-lg border border-gray-200">
          {teams.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between border-b border-gray-100 px-4 py-2 text-sm last:border-b-0"
            >
              <span className="text-gray-800">
                {t.name}
                {t.is_default && (
                  <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                    default
                  </span>
                )}
              </span>
              {canManage && !t.is_default && (
                <button
                  onClick={() => current && deleteTeam(current.id, t.id).then(() => loadOrgDetail(current))}
                  className="text-gray-400 hover:text-red-600"
                  title="Delete team"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        {canManage && (
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={newTeam}
              onChange={(e) => setNewTeam(e.target.value)}
              placeholder="New team name"
              className="max-w-xs"
            />
            <Button onClick={handleCreateTeam} disabled={busy || !newTeam.trim()}>
              <Plus className="mr-1 h-4 w-4" /> Add team
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { listOrganizations, type Organization } from "@/app/lib/orgApi";
import { setActiveOrgId, getActiveOrgId } from "@/app/lib/mikeApi";

interface OrgContextType {
  orgs: Organization[];
  activeOrg: Organization | null;
  loading: boolean;
  setActiveOrg: (orgId: string) => void;
  refresh: () => Promise<void>;
}

const OrgContext = createContext<OrgContextType | undefined>(undefined);

export function OrgProvider({ children }: { children: ReactNode }) {
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [activeOrg, setActiveOrgState] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  const pickActive = useCallback(
    (list: Organization[]): Organization | null => {
      const stored = getActiveOrgId();
      const found = stored ? list.find((o) => o.id === stored) : undefined;
      const chosen = found ?? list.find((o) => o.is_personal) ?? list[0] ?? null;
      if (chosen) setActiveOrgId(chosen.id);
      return chosen;
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const list = await listOrganizations();
      setOrgs(list);
      setActiveOrgState((prev) =>
        prev && list.some((o) => o.id === prev.id)
          ? list.find((o) => o.id === prev.id)!
          : pickActive(list),
      );
    } catch {
      // not signed in / backend unreachable — leave empty
    } finally {
      setLoading(false);
    }
  }, [pickActive]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setActiveOrg = useCallback(
    (orgId: string) => {
      const org = orgs.find((o) => o.id === orgId);
      if (!org) return;
      setActiveOrgId(org.id);
      setActiveOrgState(org);
    },
    [orgs],
  );

  return (
    <OrgContext.Provider
      value={{ orgs, activeOrg, loading, setActiveOrg, refresh }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg(): OrgContextType {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}

/**
 * Pessimistic resource locks for collaborative editing.
 *
 * A client acquires a lock before editing, heartbeats while open, and releases
 * on close. Locks auto-expire (TTL) so a crashed/closed client never blocks a
 * resource permanently. Acquire is atomic via the (resource_type,resource_id)
 * primary key.
 *
 * NOTE (v1): requires auth but does not yet re-verify per-resource access — it
 * coordinates editing, it is not an access boundary. Tighten alongside the
 * resource-scoping phase.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const locksRouter = Router();
locksRouter.use(requireAuth);

const LOCK_TTL_MS = 120_000; // 2 minutes
const ALLOWED = new Set(["document", "tabular_review", "project"]);

function expiry(): string {
  return new Date(Date.now() + LOCK_TTL_MS).toISOString();
}

async function holderEmail(db: ReturnType<typeof createServerSupabase>, userId: string) {
  try {
    const { data } = await db.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

// GET /locks/:type/:id — current lock status
locksRouter.get("/:type/:id", async (req, res) => {
  const db = createServerSupabase();
  const { type, id } = req.params;
  const { data } = await db
    .from("resource_locks")
    .select("*")
    .eq("resource_type", type)
    .eq("resource_id", id)
    .maybeSingle();
  if (!data) return void res.json({ locked: false });
  const lock = data as { locked_by: string; expires_at: string };
  if (new Date(lock.expires_at).getTime() < Date.now()) {
    return void res.json({ locked: false });
  }
  res.json({
    locked: true,
    locked_by: lock.locked_by,
    locked_by_email: await holderEmail(db, lock.locked_by),
    expires_at: lock.expires_at,
    mine: lock.locked_by === (res.locals.userId as string),
  });
});

// POST /locks/:type/:id/acquire
locksRouter.post("/:type/:id/acquire", async (req, res) => {
  const db = createServerSupabase();
  const { type, id } = req.params;
  const userId = res.locals.userId as string;
  if (!ALLOWED.has(type)) {
    return void res.status(400).json({ detail: "invalid resource type" });
  }
  // Clear an expired lock if present.
  await db
    .from("resource_locks")
    .delete()
    .eq("resource_type", type)
    .eq("resource_id", id)
    .lt("expires_at", new Date().toISOString());

  const { error } = await db.from("resource_locks").insert({
    resource_type: type,
    resource_id: id,
    locked_by: userId,
    expires_at: expiry(),
  });

  if (error) {
    // PK conflict → someone holds it. If it's us, refresh; else 409.
    const { data } = await db
      .from("resource_locks")
      .select("*")
      .eq("resource_type", type)
      .eq("resource_id", id)
      .maybeSingle();
    const lock = data as { locked_by: string; expires_at: string } | null;
    if (lock && lock.locked_by === userId) {
      await db
        .from("resource_locks")
        .update({ heartbeat_at: new Date().toISOString(), expires_at: expiry() })
        .eq("resource_type", type)
        .eq("resource_id", id);
      return void res.json({ acquired: true, expires_at: expiry() });
    }
    return void res.status(409).json({
      acquired: false,
      locked_by: lock?.locked_by ?? null,
      locked_by_email: lock ? await holderEmail(db, lock.locked_by) : null,
      expires_at: lock?.expires_at ?? null,
    });
  }
  res.json({ acquired: true, expires_at: expiry() });
});

// POST /locks/:type/:id/heartbeat — extend if holder
locksRouter.post("/:type/:id/heartbeat", async (req, res) => {
  const db = createServerSupabase();
  const { type, id } = req.params;
  const userId = res.locals.userId as string;
  const { data } = await db
    .from("resource_locks")
    .update({ heartbeat_at: new Date().toISOString(), expires_at: expiry() })
    .eq("resource_type", type)
    .eq("resource_id", id)
    .eq("locked_by", userId)
    .select()
    .maybeSingle();
  if (!data) return void res.status(409).json({ detail: "You do not hold this lock" });
  res.json({ ok: true, expires_at: expiry() });
});

// DELETE /locks/:type/:id — release if holder
locksRouter.delete("/:type/:id", async (req, res) => {
  const db = createServerSupabase();
  const { type, id } = req.params;
  const userId = res.locals.userId as string;
  await db
    .from("resource_locks")
    .delete()
    .eq("resource_type", type)
    .eq("resource_id", id)
    .eq("locked_by", userId);
  res.status(204).end();
});

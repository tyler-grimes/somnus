/**
 * Visibility enforcement (security research #4).
 *
 * facts.visibility ('private' | 'shared' | 'world') existed in the schema but
 * no read path referenced it — a dead control that a future share/export
 * feature would have trusted and leaked through. Every facts read now goes
 * through visibilityClause(); the audience defaults to 'owner' (Tyler's own
 * agent, sees everything) and comes from BRAIN_AUDIENCE for any future
 * outward-facing deployment of this server.
 *
 * Outward-facing tools must additionally read from the facts_world /
 * facts_shared views (db/init/002_visibility.sql), never from facts directly.
 */
export type Audience = "owner" | "shared" | "world";

export function resolveAudience(raw: string | undefined): Audience {
  return raw === "shared" || raw === "world" ? raw : "owner";
}

/** SQL predicate restricting a facts query to what `audience` may see. */
export function visibilityClause(audience: Audience): string {
  if (audience === "owner") return "TRUE"; // owner sees all
  if (audience === "shared") return "visibility IN ('shared','world')";
  return "visibility = 'world'";
}

/**
 * Drains web_chat: claims one pending row at a time (FOR UPDATE SKIP LOCKED),
 * runs it through the shared turn mutex, writes the reply back. Self-paced —
 * processes immediately while work exists, idles 2s when the queue is empty.
 * A failed turn is recorded as status='error' with the error text; a DB error
 * leaves the row for the next pass (never lost).
 */
import { pool } from "./db.js";
import { runTurnExclusive } from "./agent.js";

const IDLE_MS = 2000;
let running = false;

async function claimOne(): Promise<{ id: string; prompt: string } | null> {
  const { rows } = await pool.query(
    `UPDATE web_chat SET status='running'
       WHERE id = (
         SELECT id FROM web_chat WHERE status='pending'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, prompt`,
  );
  return rows[0] ?? null;
}

export function startWebChatPoller(): void {
  if (running) return;
  running = true;
  // Requeue rows orphaned at 'running' by a prior crash/restart (e.g. a turn
  // in flight during a deploy) so the dashboard isn't left polling forever.
  pool
    .query(`UPDATE web_chat SET status='pending' WHERE status='running'`)
    .then((r) => { if (r.rowCount) console.log(`[webchat] requeued ${r.rowCount} orphaned turn(s)`); })
    .catch((err) => console.error("[webchat] requeue on boot failed:", err));
  const tick = async () => {
    let claimed: { id: string; prompt: string } | null = null;
    try {
      claimed = await claimOne();
      if (claimed) {
        try {
          const reply = await Promise.race([
            runTurnExclusive(claimed.prompt, "web"),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("web turn timeout")),
                10 * 60 * 1000,
              ),
            ),
          ]);
          await pool.query(
            `UPDATE web_chat SET reply=$2, status='done', answered_at=now() WHERE id=$1`,
            [claimed.id, reply],
          );
        } catch (err) {
          await pool.query(
            `UPDATE web_chat SET reply=$2, status='error', answered_at=now() WHERE id=$1`,
            [claimed.id, err instanceof Error ? err.message : String(err)],
          );
        }
      }
    } catch (err) {
      console.error("[webchat] poll failed:", err);   // DB hiccup — try again next pass
    }
    setTimeout(tick, claimed ? 0 : IDLE_MS);
  };
  console.log("[boot] web chat poller up");
  void tick();
}

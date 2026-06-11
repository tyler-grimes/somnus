/**
 * Dream cycle — nightly memory consolidation, run as ordered idempotent phases.
 * Design: research/brain-architecture.md (consolidation) + gbrain teardown.
 *
 * Phases:
 *   1. extract   — distill atomic facts from recent episodes (async, off the
 *                  write path — episodes were stored losslessly at chat time)
 *   2. contradict— find new facts that clash with old ones; supersede, never delete
 *   3. reflect   — write/update the daily summary page
 *   4. cluster   — group unresolved friction events by similarity
 *   5. skills    — draft SKILL.md candidates from hot clusters (human-gated)
 *   6. decay     — notability decay + purge expired soft-deletes
 *
 * Every phase is wrapped: one phase failing never blocks the rest.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { logEpisode, pool, spentTodayUsd } from "./db.js";
import { extractStructured } from "./llm.js";

const SKILLS_PENDING_DIR = path.resolve(import.meta.dirname, "../../.claude/skills-pending");
const EPISODE_WINDOW = "36 hours"; // > daily cadence; dedupe makes re-runs safe

const FACT_KINDS = ["event", "preference", "commitment", "belief", "fact", "habit", "persona"] as const;

// ---------- Phase 1: extract facts ----------
async function extractFacts(): Promise<string> {
  const eps = await pool.query(
    `SELECT role, content, created_at FROM episodes
      WHERE created_at > now() - interval '${EPISODE_WINDOW}'
        AND source != 'dream_cycle' AND role IN ('user','assistant')
      ORDER BY created_at ASC LIMIT 400`,
  );
  if (eps.rowCount === 0) return "extract: no new episodes";

  const transcript = eps.rows
    .map((r) => `[${r.created_at.toISOString()}] ${r.role}: ${r.content}`)
    .join("\n")
    .slice(0, 60_000);

  const schema = z.object({
    facts: z.array(
      z.object({
        kind: z.enum(FACT_KINDS),
        claim: z.string().describe("One self-contained sentence, naming Tyler explicitly"),
        confidence: z.number().min(0).max(1),
        valid_from: z.string().nullable().describe("YYYY-MM-DD when this became true, or null"),
      }),
    ),
  });

  const out = await extractStructured({
    purpose: "dream:extract_facts",
    system:
      "You are the memory-consolidation process of Tyler's second brain. Extract durable atomic facts about Tyler, his work, his people, and his world from this conversation transcript. Only include things worth remembering in a month: preferences, commitments, beliefs, habits, notable events, stable facts. Skip pleasantries, transient task chatter, and anything already implied by another extracted fact. Empty list is a fine answer.",
    user: transcript,
    schema,
  });

  let inserted = 0;
  for (const f of out.facts) {
    // Dedupe: skip if an active fact already says (almost) this
    const dup = await pool.query(
      `SELECT 1 FROM facts
        WHERE superseded_at IS NULL AND similarity(claim, $1) > 0.55 LIMIT 1`,
      [f.claim],
    );
    if (dup.rowCount) continue;
    await pool.query(
      `INSERT INTO facts (kind, claim, confidence, valid_from, source)
       VALUES ($1, $2, $3, $4, 'dream:extract')`,
      [f.kind, f.claim, f.confidence, f.valid_from],
    );
    inserted++;
  }
  return `extract: ${out.facts.length} candidates, ${inserted} new facts stored`;
}

// ---------- Phase 2: resolve contradictions ----------
async function resolveContradictions(): Promise<string> {
  const pairs = await pool.query(
    `SELECT n.id AS new_id, n.claim AS new_claim, o.id AS old_id, o.claim AS old_claim
       FROM facts n
       JOIN facts o ON o.id != n.id AND o.kind = n.kind AND o.recorded_at < n.recorded_at
      WHERE n.superseded_at IS NULL AND o.superseded_at IS NULL
        AND n.recorded_at > now() - interval '${EPISODE_WINDOW}'
        AND similarity(n.claim, o.claim) > 0.3
      LIMIT 40`,
  );
  if (pairs.rowCount === 0) return "contradict: no candidate pairs";

  const schema = z.object({
    decisions: z.array(
      z.object({
        new_id: z.string(),
        old_id: z.string(),
        verdict: z.enum(["contradicts", "duplicate", "compatible"]),
      }),
    ),
  });
  const out = await extractStructured({
    purpose: "dream:contradictions",
    system:
      "You judge pairs of memory facts. 'contradicts' = both cannot be true now (the newer one updates reality). 'duplicate' = same information twice. 'compatible' = both can stand. Return a verdict for every pair given.",
    user: JSON.stringify(pairs.rows, null, 1),
    schema,
  });

  let superseded = 0;
  for (const d of out.decisions) {
    if (d.verdict === "contradicts") {
      // newer fact wins: close the old one, keep full history
      await pool.query(
        `UPDATE facts SET superseded_at = now(), superseded_by = $2,
                valid_until = COALESCE(valid_until, CURRENT_DATE)
          WHERE id = $1 AND superseded_at IS NULL`,
        [d.old_id, d.new_id],
      );
      superseded++;
    } else if (d.verdict === "duplicate") {
      // older fact wins: the new one was redundant
      await pool.query(
        `UPDATE facts SET superseded_at = now(), superseded_by = $2
          WHERE id = $1 AND superseded_at IS NULL`,
        [d.new_id, d.old_id],
      );
    }
  }
  return `contradict: ${pairs.rowCount} pairs judged, ${superseded} facts superseded`;
}

// ---------- Phase 3: daily reflection ----------
async function reflect(): Promise<string> {
  const eps = await pool.query(
    `SELECT role, source, content FROM episodes
      WHERE created_at > now() - interval '24 hours' AND source != 'dream_cycle'
      ORDER BY created_at ASC LIMIT 300`,
  );
  if (eps.rowCount === 0) return "reflect: quiet day, no entry";

  const schema = z.object({
    summary: z.string().describe("3-8 sentence diary-style summary of Tyler's day with this agent"),
    open_threads: z.array(z.string()).describe("Unfinished topics worth following up on"),
  });
  const out = await extractStructured({
    purpose: "dream:reflect",
    system:
      "Write the daily reflection entry for Tyler's second brain: what happened, what mattered, what's unfinished.",
    user: eps.rows.map((r) => `${r.role}(${r.source}): ${r.content}`).join("\n").slice(0, 40_000),
    schema,
  });

  const today = new Date().toISOString().slice(0, 10);
  const body = `${out.summary}\n\nOpen threads:\n${out.open_threads.map((t) => `- ${t}`).join("\n")}`;
  await pool.query(
    `INSERT INTO pages (slug, type, title, compiled_truth, effective_date)
     VALUES ($1, 'daily', $2, $3, now())
     ON CONFLICT (slug) DO UPDATE
       SET compiled_truth = EXCLUDED.compiled_truth,
           generation = pages.generation + 1, updated_at = now()`,
    [`daily-${today}`, `Daily: ${today}`, body],
  );
  return `reflect: daily-${today} written (${out.open_threads.length} open threads)`;
}

// ---------- Phase 4: cluster friction ----------
async function clusterFriction(): Promise<string> {
  const links = await pool.query(
    `SELECT a.id AS a_id, a.cluster_id AS a_cluster, b.id AS b_id, b.cluster_id AS b_cluster
       FROM friction_events a
       JOIN friction_events b ON a.id < b.id
        AND a.friction_type = b.friction_type
        AND similarity(a.description, b.description) > 0.45
      WHERE a.resolved_at IS NULL AND b.resolved_at IS NULL`,
  );
  if (links.rowCount === 0) return "cluster: nothing to cluster";

  // Union-find over similar pairs
  const clusterOf = new Map<string, string>();
  const find = (id: string): string => {
    const parent = clusterOf.get(id);
    if (!parent || parent === id) return parent ?? id;
    const root = find(parent);
    clusterOf.set(id, root);
    return root;
  };
  for (const l of links.rows) {
    const ra = find(l.a_id);
    const rb = find(l.b_id);
    clusterOf.set(ra, ra);
    if (ra !== rb) clusterOf.set(rb, ra);
  }
  // Stable cluster UUIDs per root (reuse an existing cluster_id if any member has one)
  const rootUuid = new Map<string, string>();
  for (const l of links.rows) {
    for (const [id, existing] of [
      [l.a_id, l.a_cluster],
      [l.b_id, l.b_cluster],
    ] as const) {
      const root = find(id);
      if (existing && !rootUuid.has(root)) rootUuid.set(root, existing);
    }
  }
  let updated = 0;
  const memberIds = new Set(links.rows.flatMap((l) => [l.a_id, l.b_id]));
  for (const id of memberIds) {
    const root = find(id);
    if (!rootUuid.has(root)) rootUuid.set(root, crypto.randomUUID());
    const res = await pool.query(
      `UPDATE friction_events SET cluster_id = $2 WHERE id = $1 AND cluster_id IS DISTINCT FROM $2`,
      [id, rootUuid.get(root)],
    );
    updated += res.rowCount ?? 0;
  }
  return `cluster: ${memberIds.size} events in ${rootUuid.size} clusters (${updated} updated)`;
}

// ---------- Phase 5: draft skills from hot clusters (human-gated) ----------
async function draftSkills(): Promise<string> {
  const hot = await pool.query(
    `SELECT cluster_id, array_agg(description) AS descriptions, count(*) AS n
       FROM friction_events
      WHERE resolved_at IS NULL AND cluster_id IS NOT NULL AND skill_drafted IS NULL
      GROUP BY cluster_id HAVING count(*) >= 3
      ORDER BY count(*) DESC LIMIT 3`,
  );
  if (hot.rowCount === 0) return "skills: no cluster hot enough (need 3+ similar events)";

  const drafted: string[] = [];
  for (const cluster of hot.rows) {
    const schema = z.object({
      slug: z.string().describe("kebab-case skill directory name"),
      name: z.string(),
      description: z.string().describe("One line: when this skill should trigger"),
      body: z.string().describe("The SKILL.md markdown body: concrete steps, no filler"),
    });
    const out = await extractStructured({
      purpose: "dream:draft_skill",
      system:
        "Draft an agent skill (SKILL.md) that would eliminate this recurring friction pattern in Tyler's second-brain agent. Be concrete and procedural. The skill will be human-reviewed before activation.",
      user: `Recurring friction (${cluster.n} occurrences):\n${cluster.descriptions.join("\n")}`,
      maxTokens: 4000,
      schema,
    });

    const dir = path.join(SKILLS_PENDING_DIR, out.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${out.name}\ndescription: ${out.description}\n---\n\n${out.body}\n`,
    );
    const skillId = crypto.randomUUID();
    await pool.query(`UPDATE friction_events SET skill_drafted = $2 WHERE cluster_id = $1`, [
      cluster.cluster_id,
      skillId,
    ]);
    drafted.push(out.slug);
  }
  return `skills: drafted ${drafted.join(", ")} → .claude/skills-pending/ (awaiting your review)`;
}

// ---------- Phase 6: decay + purge ----------
async function decayAndPurge(): Promise<string> {
  const decay = await pool.query(
    `UPDATE facts SET notability = GREATEST(0.05, notability * 0.98)
      WHERE superseded_at IS NULL`,
  );
  const purged = await pool.query(
    `DELETE FROM pages WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '72 hours'`,
  );
  return `decay: ${decay.rowCount} facts decayed, ${purged.rowCount} expired pages purged`;
}

// ---------- Orchestrator ----------
export async function runDreamCycle(): Promise<string> {
  const spent = await spentTodayUsd();
  if (spent >= config.dailySpendLimitUsd) {
    return `Dream cycle skipped: daily budget exhausted ($${spent.toFixed(2)}).`;
  }

  const phases: Array<[string, () => Promise<string>]> = [
    ["extract", extractFacts],
    ["contradict", resolveContradictions],
    ["reflect", reflect],
    ["cluster", clusterFriction],
    ["skills", draftSkills],
    ["decay", decayAndPurge],
  ];

  const lines: string[] = [];
  for (const [name, phase] of phases) {
    try {
      lines.push(await phase());
    } catch (err) {
      lines.push(`${name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const report = `🌙 Somnus dreamt\n${lines.map((l) => `• ${l}`).join("\n")}`;
  await logEpisode({ source: "dream_cycle", role: "system", content: report });
  return report;
}

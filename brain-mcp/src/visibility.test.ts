/**
 * Regression tests for visibility enforcement (security research #4).
 *
 * The integration test is the one that matters: it inserts a private fact and
 * asserts that a world/shared-audience query cannot see it — the exact silent
 * leak the unenforced column would have allowed. Runs inside a rolled-back
 * transaction; needs DATABASE_URL (skips loudly without it).
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import pg from "pg";
import { resolveAudience, visibilityClause } from "./visibility.js";

test("resolveAudience defaults to owner and never invents audiences", () => {
  assert.equal(resolveAudience(undefined), "owner");
  assert.equal(resolveAudience(""), "owner");
  assert.equal(resolveAudience("admin"), "owner");
  assert.equal(resolveAudience("shared"), "shared");
  assert.equal(resolveAudience("world"), "world");
});

test("visibilityClause narrows monotonically", () => {
  assert.equal(visibilityClause("owner"), "TRUE");
  assert.equal(visibilityClause("shared"), "visibility IN ('shared','world')");
  assert.equal(visibilityClause("world"), "visibility = 'world'");
});

test(
  "a private fact is invisible to non-owner audiences",
  { skip: !process.env.DATABASE_URL && "DATABASE_URL not set" },
  async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query(
        `INSERT INTO facts (kind, claim, visibility, source)
         VALUES ('fact', 'TEST-PRIVATE: this row must never leak', 'private', 'test:visibility')
         RETURNING id`,
      );
      const id = ins.rows[0].id;
      const count = async (aud: "owner" | "shared" | "world") => {
        const r = await client.query(
          `SELECT count(*)::int AS n FROM facts WHERE id = $1 AND (${visibilityClause(aud)})`,
          [id],
        );
        return r.rows[0].n;
      };
      assert.equal(await count("owner"), 1, "owner must see their own private fact");
      assert.equal(await count("shared"), 0, "shared audience must NOT see a private fact");
      assert.equal(await count("world"), 0, "world audience must NOT see a private fact");

      // Guardrail views (002_visibility.sql) must also exclude it
      const views = await client.query(
        `SELECT
           (SELECT count(*)::int FROM facts_world  WHERE id = $1) AS world,
           (SELECT count(*)::int FROM facts_shared WHERE id = $1) AS shared`,
        [id],
      );
      assert.equal(views.rows[0].world, 0, "facts_world view leaked a private fact");
      assert.equal(views.rows[0].shared, 0, "facts_shared view leaked a private fact");
      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  },
);

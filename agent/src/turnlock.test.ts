import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror of runTurnExclusive's chaining, parameterized over the work fn,
// so we can verify the concurrency contract without the SDK.
function makeRunner(work: (s: string) => Promise<string>) {
  let chain: Promise<unknown> = Promise.resolve();
  return (s: string) => {
    const r = chain.then(() => work(s));
    chain = r.catch(() => {});
    return r;
  };
}

test("runs are serialized (never overlap)", async () => {
  let active = 0, maxActive = 0;
  const work = async (s: string) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--; return s;
  };
  const run = makeRunner(work);
  await Promise.all(["a","b","c","d"].map(run));
  assert.equal(maxActive, 1);
});

test("a rejected turn does not wedge the chain", async () => {
  const run = makeRunner(async (s) => { if (s === "boom") throw new Error("x"); return s; });
  await assert.rejects(run("boom"));
  assert.equal(await run("ok"), "ok");   // chain still flows
});

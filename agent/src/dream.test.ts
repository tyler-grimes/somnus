import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCites } from "./dream.js";

describe("resolveCites (fact -> episode provenance)", () => {
  const idByCite = new Map<number, string>([
    [1, "11111111-1111-1111-1111-111111111111"],
    [2, "22222222-2222-2222-2222-222222222222"],
    [3, "33333333-3333-3333-3333-333333333333"],
  ]);

  it("maps cited line numbers to episode ids in order", () => {
    assert.deepEqual(resolveCites([1, 3], idByCite), [
      "11111111-1111-1111-1111-111111111111",
      "33333333-3333-3333-3333-333333333333",
    ]);
  });

  it("drops hallucinated / out-of-range indices", () => {
    assert.deepEqual(resolveCites([2, 999], idByCite), ["22222222-2222-2222-2222-222222222222"]);
  });

  it("collapses duplicate indices", () => {
    assert.deepEqual(resolveCites([1, 1, 1], idByCite), ["11111111-1111-1111-1111-111111111111"]);
  });

  it("returns an empty array when nothing valid is cited (binds safely as $6::uuid[])", () => {
    assert.deepEqual(resolveCites([], idByCite), []);
    assert.deepEqual(resolveCites([42], idByCite), []);
  });
});

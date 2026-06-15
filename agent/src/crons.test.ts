import { test } from "node:test";
import assert from "node:assert/strict";
import { dueSlot, isValidCron } from "./crons.js";

const tz = "America/Denver";

test("isValidCron accepts standard exprs and rejects garbage", () => {
  assert.equal(isValidCron("0 8 * * *"), true);
  assert.equal(isValidCron("0 9 * * 1-5"), true);
  assert.equal(isValidCron("not a cron"), false);
});

test("dueSlot fires when the most-recent slot is newer than last_run_at", () => {
  const now = new Date("2026-06-15T14:00:30.000Z"); // 08:00 MDT
  const slot = dueSlot("0 8 * * *", tz, null, now);
  assert.ok(slot, "should be due");
  assert.equal(slot!.toISOString(), "2026-06-15T14:00:00.000Z");
});

test("dueSlot not due when already ran this slot", () => {
  const now = new Date("2026-06-15T14:00:30.000Z");
  const lastRun = new Date("2026-06-15T14:00:00.000Z");
  assert.equal(dueSlot("0 8 * * *", tz, lastRun, now), null);
});

test("dueSlot fires once for the most-recent slot after downtime", () => {
  const now = new Date("2026-06-15T14:05:00.000Z");
  const lastRun = new Date("2026-06-15T11:00:00.000Z");
  const slot = dueSlot("0 * * * *", tz, lastRun, now);
  assert.ok(slot);
  assert.equal(slot!.toISOString(), "2026-06-15T14:00:00.000Z");
});

test("dueSlot returns null for an invalid expression (never throws)", () => {
  assert.equal(dueSlot("garbage", tz, null, new Date("2026-06-15T14:00:00.000Z")), null);
});

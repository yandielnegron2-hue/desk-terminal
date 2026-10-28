import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { positionSize, gates, chaseCheck, breakers, exitReason, spyRecord } from "../desk.js";
const cfg = JSON.parse(fs.readFileSync(new URL("../config/desk.json", import.meta.url)));
const good = { mintAuthorityRevoked: true, freezeAuthorityRevoked: true, lpLocked: true, top10Pct: 20, liquidityUsd: 50000 };

test("sizing: fixed 2% of current book, independent of last trade", () => {
  assert.equal(positionSize(1000, cfg), 20);
  assert.equal(positionSize.length, 2); // no trade-history argument exists
  // the post's example: 3 trades +50%,+50%,-90% at 2% of book ~ flat
  let book = 1000; for (const r of [0.5, 0.5, -0.9]) book += positionSize(book, cfg) * r;
  assert.ok(book > 995 && book < 1010, String(book));
});
test("sizing: below minimum trade returns 0", () => assert.equal(positionSize(0.1, cfg), 0));
test("gates: clean token passes", () => assert.ok(gates(good, cfg).pass));
for (const [k, v] of [["mintAuthorityRevoked", false], ["freezeAuthorityRevoked", false], ["lpLocked", false], ["top10Pct", 45], ["liquidityUsd", 500],
  ["mintAuthorityRevoked", null], ["freezeAuthorityRevoked", null], ["top10Pct", null], ["liquidityUsd", null], ["lpLocked", null]])
  test(`gates: reject when ${k}=${v}`, () => assert.equal(gates({ ...good, [k]: v }, cfg).pass, false));
test("spy: copy skipped when leader is too far ahead (0.0010 -> 0.0013, max 15%)", () => {
  const r = chaseCheck(0.001, 0.0013, 15); assert.equal(r.skip, true); assert.ok(Math.abs(r.chasePct - 30) < 1e-6);
});
test("spy: copy allowed at exactly 15% chase", () => assert.equal(chaseCheck(0.001, 0.00115, 15).skip, false));
test("spy: demote after 3 consecutive losing copies, reset on win", () => {
  let w = {}; w = spyRecord(w, false, cfg); w = spyRecord(w, false, cfg); assert.equal(w.demoted, false);
  w = spyRecord(w, true, cfg); assert.equal(w.consecutiveLosses, 0);
  for (let i = 0; i < 3; i++) w = spyRecord(w, false, cfg); assert.equal(w.demoted, true);
});
const base = { book: 1, dayStartBook: 1, consecutiveLosses: 0, feedTimeSec: 1000 };
test("breaker: daily loss cap fires", () => assert.ok(breakers({ ...base, book: 0.89 }, cfg, 1000).dailyLoss));
test("breaker: daily loss cap quiet under cap", () => assert.equal(breakers({ ...base, book: 0.95 }, cfg, 1000).blockEntries, false));
test("breaker: consecutive losses fires", () => assert.ok(breakers({ ...base, consecutiveLosses: 3 }, cfg, 1000).blockEntries));
test("breaker: feed lag fires when stale", () => assert.ok(breakers(base, cfg, 1000 + cfg.feedLagMaxSec + 1).feedLag));
test("breaker: feed lag fires when feed time unknown", () => assert.ok(breakers({ ...base, feedTimeSec: null }, cfg, 1000).feedLag));
test("breaker: kill switch blocks entries", () => assert.ok(breakers({ ...base, kill: true }, cfg, 1000).blockEntries));
test("breaker: liquidity drop forces exit", () => assert.equal(exitReason({ entryPrice: 1, entryLiq: 20000 }, 1, 9000, cfg), "liquidity-drop"));
test("exits: take-profit and stop-loss", () => {
  assert.equal(exitReason({ entryPrice: 1, entryLiq: 1 }, 2.1, 1, cfg), "take-profit");
  assert.equal(exitReason({ entryPrice: 1, entryLiq: 1 }, 0.6, 1, cfg), "stop-loss");
});

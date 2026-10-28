// Pure risk logic. Every rule here has a test in test/desk.test.js.
export const positionSize = (book, cfg) => {
  // Hard rule: fixed fraction of CURRENT book. Takes no trade history by design.
  const s = book * cfg.sizeFraction;
  return s >= cfg.minTradeSol ? s : 0;
};

// Gates REJECT; unknown (null/undefined) is a reject.
export function gates(c, cfg) {
  const fails = [];
  if (c.mintAuthorityRevoked !== true) fails.push(c.mintAuthorityRevoked == null ? "mint authority unknown" : "mint authority active");
  if (c.freezeAuthorityRevoked !== true) fails.push(c.freezeAuthorityRevoked == null ? "freeze authority unknown" : "freeze authority active");
  if (c.lpLocked === false) fails.push("LP not locked/burned");
  if (c.lpLocked == null && cfg.lpUnknownRejects) fails.push("LP status unknown");
  if (c.top10Pct == null) fails.push("top-10 share unknown");
  else if (c.top10Pct > cfg.maxTop10Pct) fails.push(`top-10 ${c.top10Pct.toFixed(1)}% > ${cfg.maxTop10Pct}%`);
  if (c.liquidityUsd == null) fails.push("liquidity unknown");
  else if (c.liquidityUsd < cfg.minLiquidityUsd) fails.push(`liq $${Math.round(c.liquidityUsd)} < $${cfg.minLiquidityUsd}`);
  return { pass: fails.length === 0, fails };
}

export function chaseCheck(leaderEntry, quote, maxChasePct) {
  const chasePct = (quote / leaderEntry - 1) * 100;
  return { skip: !(chasePct <= maxChasePct + 1e-9), chasePct };
}

export function breakers(s, cfg, nowSec) {
  const out = {};
  out.dailyLoss = s.dayStartBook > 0 && ((s.book - s.dayStartBook) / s.dayStartBook) * 100 <= -cfg.dailyLossCapPct;
  out.consecutiveLosses = s.consecutiveLosses >= cfg.maxConsecutiveLosses;
  out.feedLag = s.feedTimeSec == null || nowSec - s.feedTimeSec > cfg.feedLagMaxSec;
  out.kill = !!s.kill;
  out.blockEntries = Object.values(out).some(Boolean);
  return out;
}

export const liquidityDropped = (entryLiq, nowLiq, cfg) =>
  entryLiq > 0 && (nowLiq == null || ((nowLiq - entryLiq) / entryLiq) * 100 <= -cfg.liquidityDropExitPct);

export function exitReason(pos, priceNow, liqNow, cfg) {
  if (priceNow == null) return null;
  const pct = (priceNow / pos.entryPrice - 1) * 100;
  if (pct >= cfg.takeProfitPct) return "take-profit";
  if (pct <= cfg.stopLossPct) return "stop-loss";
  if (liquidityDropped(pos.entryLiq, liqNow, cfg)) return "liquidity-drop";
  return null;
}

export function spyRecord(w, won, cfg) {
  const losses = won ? 0 : (w.consecutiveLosses || 0) + 1;
  return { ...w, consecutiveLosses: losses, demoted: w.demoted || losses >= cfg.spy.demoteAfterLosses };
}

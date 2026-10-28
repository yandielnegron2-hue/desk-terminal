import fs from "node:fs";
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { positionSize, gates, chaseCheck, breakers, exitReason, spyRecord } from "./desk.js";

const cfg = JSON.parse(fs.readFileSync("config/desk.json"));
const spyCfg = JSON.parse(fs.readFileSync("config/spy_wallets.json"));
const MODE = (process.env.MODE || "PAPER").toUpperCase() === "LIVE" ? "LIVE" : "PAPER";
const KILL = /^(1|true|on|yes)$/i.test(process.env.KILL || "");
const conn = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
const SOL = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";
const now = Math.floor(Date.now() / 1000);
const day = new Date().toISOString().slice(0, 10);
const S = fs.existsSync("state.json") ? JSON.parse(fs.readFileSync("state.json")) :
  { paperSol: 1, positions: [], log: [], consecutiveLosses: 0, day, dayStartBook: null, seen: {}, spy: {} };
const log = (type, msg, extra = {}) => { S.log.unshift({ t: new Date().toISOString(), mode: MODE, type, msg, ...extra }); console.log(type, msg); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error(u.split("?")[0] + " " + r.status); return r.json(); };

let kp = null;
if (process.env.SOLANA_PRIVATE_KEY) kp = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY.trim()));
const wallet = kp ? kp.publicKey.toBase58() : null;
let walletSol = null;
if (wallet) try { walletSol = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL; } catch (e) { log("warn", "balance read failed: " + e.message); }

async function market(mints) {
  const out = {};
  for (let i = 0; i < mints.length; i += 30) {
    const d = await j("https://api.dexscreener.com/latest/dex/tokens/" + mints.slice(i, i + 30).join(","));
    for (const p of d.pairs || []) {
      const a = p.baseToken.address, liq = p.liquidity?.usd ?? null;
      if (p.chainId === "solana" && (!out[a] || (liq || 0) > (out[a].liq || 0)))
        out[a] = { price: p.priceUsd ? +p.priceUsd : null, liq, dex: p.dexId, pair: p.pairAddress, sym: p.baseToken.symbol };
    }
  }
  return out;
}

async function checks(mint, m) {
  const c = { liquidityUsd: m?.liq ?? null, mintAuthorityRevoked: null, freezeAuthorityRevoked: null, top10Pct: null,
    // LP: PumpSwap migrations burn LP by protocol; pump.fun bonding curve has no withdrawable LP. Anything else: unknown.
    lpLocked: m ? (["pumpswap", "pumpfun"].includes(m.dex) ? true : null) : null };
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const p = info.value?.data?.parsed?.info;
    if (p) { c.mintAuthorityRevoked = p.mintAuthority == null; c.freezeAuthorityRevoked = p.freezeAuthority == null; }
    const supply = +(await conn.getTokenSupply(new PublicKey(mint))).value.uiAmount;
    const largest = (await conn.getTokenLargestAccounts(new PublicKey(mint))).value;
    const accs = await conn.getMultipleParsedAccounts(largest.map(l => l.address));
    // exclude the pool's own vault (owned by the DexScreener pair address)
    const holders = largest.filter((l, i) => accs.value[i]?.data?.parsed?.info?.owner !== m?.pair);
    c.top10Pct = supply > 0 ? holders.slice(0, 10).reduce((s, l) => s + (l.uiAmount || 0), 0) / supply * 100 : null;
  } catch (e) { c.error = e.message; }
  return c;
}

async function swap(inMint, outMint, amount) {
  const q = await j(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${cfg.slippageBps}`);
  const { swapTransaction } = await j(`${JUP}/swap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }) });
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const res = await conn.confirmTransaction(sig, "confirmed");
  if (res.value.err) throw new Error("tx failed " + sig);
  return { sig, outAmount: +q.outAmount };
}

// ---------- cycle ----------
const callsUrl = process.env.CALLS_URL || "../data/calls.json";
const feed = callsUrl.startsWith("http") ? await j(callsUrl) : JSON.parse(fs.readFileSync(callsUrl));
const feedTimeSec = feed.scrapedAt ? Math.floor(Date.parse(feed.scrapedAt) / 1000) : null;
const mints = [...new Set([...S.positions.map(p => p.mint), ...feed.calls.filter(c => c.ca && now - Date.parse(c.time) / 1000 <= cfg.maxCallAgeSec).map(c => c.ca)])];
let mk = {};
try { mk = await market(mints); } catch (e) { log("warn", "DexScreener failed: " + e.message); }

const posValue = p => (mk[p.mint]?.price && p.entryPrice) ? p.sol * mk[p.mint].price / p.entryPrice : p.sol;
const book = () => (MODE === "LIVE" ? (walletSol ?? 0) : S.paperSol) + S.positions.reduce((s, p) => s + posValue(p), 0);
if (S.day !== day || S.dayStartBook == null) { S.day = day; S.dayStartBook = book(); }

// exits first (exits are never blocked by breakers)
for (const p of [...S.positions]) {
  const m = mk[p.mint]; const why = exitReason(p, m?.price ?? null, m ? m.liq : null, cfg) || (p.mirrorExit ? "mirror-exit" : null);
  if (!why) continue;
  const val = posValue(p);
  try {
    if (MODE === "LIVE") {
      const bal = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(p.mint) });
      const raw = bal.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
      if (raw > 0n) { const r = await swap(p.mint, SOL, raw.toString()); log("sell", `${p.sym} ${why}`, { sig: r.sig }); }
    } else { S.paperSol += val; log("sell", `PAPER ${p.sym} ${why} ${val.toFixed(4)} SOL (in ${p.sol.toFixed(4)})`); }
    const won = val > p.sol;
    S.consecutiveLosses = won ? 0 : S.consecutiveLosses + 1;
    if (p.leader) S.spy[p.leader] = spyRecord(S.spy[p.leader] || {}, won, cfg);
    S.positions = S.positions.filter(x => x !== p);
  } catch (e) { log("error", `exit ${p.sym} failed: ${e.message}`); }
}
if (MODE === "LIVE") try { walletSol = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL; } catch {}

const br = breakers({ book: book(), dayStartBook: S.dayStartBook, consecutiveLosses: S.consecutiveLosses, feedTimeSec, kill: KILL }, cfg, now);
if (MODE === "LIVE" && !kp) { br.noKey = true; br.blockEntries = true; }

async function enter(mint, sym, source, leader, leaderEntry) {
  if (S.positions.length >= cfg.maxOpenPositions) return log("skip", `${sym}: max open positions`);
  if (S.positions.some(p => p.mint === mint)) return;
  const m = mk[mint]; const g = gates(await checks(mint, m), cfg);
  if (!g.pass) return log("reject", `${sym}: ${g.fails.join("; ")}`, { mint, source });
  let size = positionSize(book(), cfg);
  if (leader) size = Math.min(size, book() * cfg.spy.perWalletCapFraction - S.positions.filter(p => p.leader === leader).reduce((s, p) => s + p.sol, 0));
  const free = (MODE === "LIVE" ? walletSol : S.paperSol) - cfg.solReserve;
  if (size < cfg.minTradeSol || size > free) return log("skip", `${sym}: size ${size.toFixed(4)} SOL vs free ${free.toFixed(4)} (reserve kept)`);
  if (leader && leaderEntry && m?.price) {
    const ch = chaseCheck(leaderEntry, m.price, cfg.spy.maxChasePct);
    if (ch.skip) return log("skip", `${sym}: chase ${ch.chasePct.toFixed(1)}% > ${cfg.spy.maxChasePct}%`, { leader });
  }
  try {
    let sig = null;
    if (MODE === "LIVE") sig = (await swap(SOL, mint, Math.floor(size * LAMPORTS_PER_SOL))).sig; else S.paperSol -= size;
    S.positions.push({ mint, sym, sol: size, entryPrice: m.price, entryLiq: m.liq, t: new Date().toISOString(), source, leader: leader || null });
    log("buy", `${MODE === "PAPER" ? "PAPER " : ""}${sym} ${size.toFixed(4)} SOL @ $${m.price}`, { mint, source, sig });
  } catch (e) { log("error", `buy ${sym} failed: ${e.message}`); }
}

if (br.blockEntries) log("breaker", "entries blocked: " + Object.entries(br).filter(([k, v]) => v && k !== "blockEntries").map(([k]) => k).join(", "));
else {
  // Gambler: fresh Telegram calls not seen before
  for (const c of feed.calls) {
    if (!c.ca || S.seen[c.ca] || now - Date.parse(c.time) / 1000 > cfg.maxCallAgeSec) continue;
    S.seen[c.ca] = c.time;
    if (!mk[c.ca]?.price) { log("reject", `${c.symbol || c.ca.slice(0, 6)}: no DexScreener price`); continue; }
    await enter(c.ca, c.symbol || mk[c.ca].sym, c.channel + " " + c.link);
    await sleep(300);
  }
  // Spy: leader buys from recent txs
  for (const w of spyCfg.wallets) {
    if (S.spy[w]?.demoted) { log("skip", `spy ${w.slice(0, 6)} demoted`); continue; }
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(w), { limit: 10 });
      for (const s of sigs) {
        if (S.seen[s.signature] || !s.blockTime || now - s.blockTime > cfg.maxCallAgeSec) continue;
        S.seen[s.signature] = 1;
        const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); if (!tx) continue;
        const idx = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.toBase58() === w);
        const solD = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL;
        const pre = tx.meta.preTokenBalances.filter(b => b.owner === w), post = tx.meta.postTokenBalances.filter(b => b.owner === w);
        for (const b of post) {
          if (b.mint === SOL) continue;
          const d = (b.uiTokenAmount.uiAmount || 0) - (pre.find(x => x.mint === b.mint)?.uiTokenAmount.uiAmount || 0);
          const lag = now - s.blockTime;
          if (d > 0 && solD < 0) {
            if (!mk[b.mint]) Object.assign(mk, await market([b.mint]));
            const m = mk[b.mint]; if (!m?.price) continue;

            // compare in SOL/token: our quote now from Jupiter
            const q = await j(`${JUP}/quote?inputMint=${SOL}&outputMint=${b.mint}&amount=${Math.floor(0.01 * LAMPORTS_PER_SOL)}&slippageBps=${cfg.slippageBps}`).catch(() => null);
            const dec = b.uiTokenAmount.decimals;
            const ourSolPerToken = q ? 0.01 / (+q.outAmount / 10 ** dec) : null;
            if (ourSolPerToken == null) { log("skip", `spy ${w.slice(0, 6)} ${m.sym}: no quote`); continue; }
            const ch = chaseCheck(-solD / d, ourSolPerToken, cfg.spy.maxChasePct);
            if (ch.skip) { log("skip", `spy ${w.slice(0, 6)} ${m.sym}: chase ${ch.chasePct.toFixed(1)}% > ${cfg.spy.maxChasePct}%, lag ${lag}s`, { leader: w }); continue; }
            await enter(b.mint, m.sym, "spy " + w, w, null);
          }
          if (d < 0) S.positions.filter(p => p.leader === w && p.mint === b.mint).forEach(p => { p.mirrorExit = true; log("info", `spy ${w.slice(0, 6)} sold ${p.sym}: mirror exit next cycle`); });
        }
      }
    } catch (e) { log("error", `spy ${w.slice(0, 6)}: ${e.message}`); }
  }
}

S.log = S.log.slice(0, 200);
S.lastRun = new Date().toISOString();
fs.writeFileSync("state.json", JSON.stringify(S, null, 1));
fs.writeFileSync("../data/desk.json", JSON.stringify({
  updated: S.lastRun, mode: MODE, kill: KILL, wallet, walletSol, book: book(), dayStartBook: S.dayStartBook,
  pnlTodayPct: S.dayStartBook ? (book() / S.dayStartBook - 1) * 100 : null, consecutiveLosses: S.consecutiveLosses,
  breakers: br, feedLagSec: feedTimeSec ? now - feedTimeSec : null, config: cfg, spyWallets: spyCfg.wallets.map(w => ({ w, ...(S.spy[w] || {}) })),
  positions: S.positions.map(p => ({ ...p, priceNow: mk[p.mint]?.price ?? null, liqNow: mk[p.mint]?.liq ?? null, valueSol: posValue(p) })),
  log: S.log.slice(0, 60) }, null, 1));
console.log("done", MODE, "book", book().toFixed(4), "breakers", JSON.stringify(br));

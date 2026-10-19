import type { Breakdown, Swap, Transfer } from "./breakdown.ts";

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

/** Lamports → "0.012375 SOL" (or "—" for zero). */
export function sol(lamports: bigint, dash = false): string {
  if (dash && lamports === 0n) return "—";
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, "0").slice(0, 6);
  return `${neg ? "-" : ""}${whole}.${frac} SOL`;
}

/** part / whole as a percentage with two decimals. */
export function pct(part: bigint, whole: bigint): string {
  if (whole === 0n) return "n/a";
  return `${(Number((part * 1_000_000n) / whole) / 10_000).toFixed(2)}%`;
}

const row = (label: string, value: string, note = "") => `  ${label.padEnd(30)} ${value.padStart(16)}${note ? `   ${note}` : ""}`;
const sum = (xs: Transfer[]) => xs.reduce((a, t) => a + t.lamports, 0n);
const to = (xs: Transfer[]) => xs.map((t) => `${sol(t.lamports)} → ${short(t.to)}`).join(", ");

export function swapFees(s: Swap): bigint {
  return s.lpFee + s.protocolFee + s.creatorFee;
}

function formatSwap(s: Swap): string[] {
  const fees = swapFees(s);
  const lines = [
    `${s.side.toUpperCase()} · ${s.instruction} · pool ${short(s.pool)} · user ${short(s.user)}`,
    row("Swap along the pool curve", sol(s.curveLamports)),
    row("LP fee (stays in the pool)", sol(s.lpFee), `${s.bps.lp} bps`),
    row(
      "Protocol fee",
      sol(s.protocolFee),
      `${s.bps.protocol} bps${s.buybackFee > 0n ? ` · of which buyback ${sol(s.buybackFee)}` : ""}`,
    ),
    row("Creator fee", sol(s.creatorFee), `${s.bps.creator} bps`),
    row(s.side === "buy" ? "User paid" : "User received", sol(s.userLamports), `fees ${pct(fees, s.curveLamports)} of the swap`),
  ];
  if (s.cashback > 0n) lines.push(row("Cashback to the trader", sol(s.cashback)));
  if (s.payouts.length) lines.push(`  Fees paid out now: ${to(s.payouts)}`);
  if (s.heldInPool !== null && s.heldInPool > 0n) lines.push(`  Fees held in the pool vault for later collection: ${sol(s.heldInPool)}`);
  return lines;
}

export function formatBreakdown(b: Breakdown): string {
  const lines: string[] = [];
  for (const s of b.swaps) lines.push(...formatSwap(s), "");
  if (b.swaps.length === 0) lines.push("No PumpSwap buy or sell in this transaction.", "");
  const tips = sum(b.jitoTips);
  const other = sum(b.otherTransfers);
  lines.push(
    "Transaction",
    row("Network fee", sol(b.networkFee.base), `+ priority ${sol(b.networkFee.priority)}`),
    row("Jito tips", sol(tips, true), b.jitoTips.length ? to(b.jitoTips) : ""),
    row("Other transfers (tips, bot fees)", sol(other, true), b.otherTransfers.length ? to(b.otherTransfers) : ""),
    row("Rent parked (refundable)", sol(b.rentLamports, true)),
  );
  if (b.swaps.length) {
    const curve = b.swaps.reduce((a, s) => a + s.curveLamports, 0n);
    const allIn = b.swaps.reduce((a, s) => a + swapFees(s), 0n) + b.networkFee.base + b.networkFee.priority + tips + other;
    const checks = b.swaps.map((s) => `${s.eventReconciles ? "✓" : "✗"} event adds up · ${s.feesAccounted === null ? "? vault not in balances" : s.feesAccounted ? "✓ fees = paid out + held in pool" : "✗ fees do not match the vault"}`);
    lines.push("", `All-in cost: ${sol(allIn)} = ${pct(allIn, curve)} of the swap`, `Checks: ${checks.join(" | ")}`);
  }
  return lines.join("\n");
}

export interface PoolSummary {
  pool: string;
  transactions: number;
  swaps: Swap[];
  breakdowns: Breakdown[];
}

export function formatPoolSummary(p: PoolSummary): string {
  const buys = p.swaps.filter((s) => s.side === "buy").length;
  const curve = p.swaps.reduce((a, s) => a + s.curveLamports, 0n);
  const add = (f: (s: Swap) => bigint) => p.swaps.reduce((a, s) => a + f(s), 0n);
  const tiers = new Map<string, number>();
  for (const s of p.swaps) {
    const k = `${s.bps.lp}/${s.bps.protocol}/${s.bps.creator} bps`;
    tiers.set(k, (tiers.get(k) ?? 0) + 1);
  }
  const withTips = p.breakdowns.filter((b) => b.jitoTips.length > 0);
  const withOther = p.breakdowns.filter((b) => b.otherTransfers.length > 0);
  const recipients = new Map<string, bigint>();
  for (const b of withOther) for (const t of b.otherTransfers) recipients.set(t.to, (recipients.get(t.to) ?? 0n) + t.lamports);
  const topRecipients = [...recipients.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
  const priority = p.breakdowns.reduce((a, b) => a + b.networkFee.priority, 0n);
  const fees = add(swapFees);
  return [
    `Pool ${p.pool} · last ${p.transactions} transactions · ${p.swaps.length} swaps (${buys} buys, ${p.swaps.length - buys} sells)`,
    row("Volume along the curve", sol(curve)),
    row("LP fees", sol(add((s) => s.lpFee))),
    row("Protocol fees", sol(add((s) => s.protocolFee)), `of which buyback ${sol(add((s) => s.buybackFee))}`),
    row("Creator fees", sol(add((s) => s.creatorFee))),
    row("All swap fees", sol(fees), `${pct(fees, curve)} of volume`),
    row("Held in the pool for later", sol(add((s) => (s.heldInPool && s.heldInPool > 0n ? s.heldInPool : 0n)))),
    `  Fee tiers seen: ${[...tiers.entries()].map(([k, n]) => `${k} ×${n}`).join(", ") || "—"}`,
    `  Priority fees: ${sol(priority)} in total, ${p.breakdowns.length ? sol(priority / BigInt(p.breakdowns.length)) : "—"} per transaction`,
    `  Jito tips: ${withTips.length} of ${p.breakdowns.length} transactions, ${sol(withTips.reduce((a, b) => a + sum(b.jitoTips), 0n))} in total`,
    `  Other transfers (bot / terminal fees): ${withOther.length} transactions` +
      (topRecipients.length ? `, top recipients: ${topRecipients.map(([a, l]) => `${short(a)} ${sol(l)}`).join(", ")}` : ""),
  ].join("\n");
}

export interface FeeTierRow {
  thresholdLamports: bigint;
  lp: bigint;
  protocol: bigint;
  creator: bigint;
}

export function formatTiers(rows: FeeTierRow[]): string {
  const lines = [`  ${"market cap from".padEnd(18)} ${"LP".padStart(5)} ${"protocol".padStart(9)} ${"creator".padStart(8)} ${"total".padStart(8)}`];
  for (const r of rows) {
    const cap = `${(Number(r.thresholdLamports / 1_000_000n) / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} SOL`;
    lines.push(
      `  ${cap.padEnd(18)} ${String(r.lp).padStart(5)} ${String(r.protocol).padStart(9)} ${String(r.creator).padStart(8)} ${`${r.lp + r.protocol + r.creator} bps`.padStart(8)}`,
    );
  }
  return lines.join("\n");
}

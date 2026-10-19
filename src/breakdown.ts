import { base58Decode, EVENT_IX_TAG, type DecodedEvent, type IdlCodec } from "./idl.ts";
import type { Instruction, ParsedTx, TokenBalance } from "./tx.ts";

export const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";
const SYSTEM = "11111111111111111111111111111111";

/** Jito's published tip accounts. */
export const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

export interface Swap {
  side: "buy" | "sell";
  instruction: string;
  pool: string;
  user: string;
  baseAmount: bigint;
  /** SOL that moved along the pool's curve (before the fees around it). */
  curveLamports: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** Part of the protocol fee routed to buybacks; already inside protocolFee. */
  buybackFee: bigint;
  cashback: bigint;
  bps: { lp: bigint; protocol: bigint; creator: bigint };
  /** Buy: what the user paid in total. Sell: what the user received. */
  userLamports: bigint;
  protocolFeeRecipient: string;
  /** The event's own totals add up. */
  eventReconciles: boolean;
  /** Fee money transferred out right away, and to whom (protocol recipient, buyback, creator vault). */
  payouts: Transfer[];
  /**
   * Fees that stayed in the pool's SOL vault for later collection: vault change minus the swap's own flow.
   * null when the vault is not in the transaction's balances.
   */
  heldInPool: bigint | null;
  /** Paid out + held in the pool = protocol + creator fees, to the lamport. */
  feesAccounted: boolean | null;
}

export interface Transfer {
  to: string;
  lamports: bigint;
}

export interface Breakdown {
  signature: string;
  feePayer: string;
  networkFee: { base: bigint; priority: bigint };
  jitoTips: Transfer[];
  /** SOL the user sent anywhere else: trading-bot and terminal fees, other tips. */
  otherTransfers: Transfer[];
  /** Rent parked in token accounts the transaction created (minus rent returned by closed ones). Refundable. */
  rentLamports: bigint;
  swaps: Swap[];
}

const big = (v: unknown) => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

/** PumpSwap Buy/Sell events in execution order: self-CPI events first, `Program data:` logs as a fallback. */
export function pumpswapEvents(tx: ParsedTx, codec: IdlCodec): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (ix.programId !== PUMPSWAP_PROGRAM || !ix.data) continue;
      const bytes = base58Decode(ix.data);
      if (!bytes.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const e = codec.decodeEvent(bytes.subarray(8));
      if (e) out.push(e);
    }
  }
  if (out.length > 0) return out;
  for (const line of tx.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const e = codec.decodeEvent(Buffer.from(line.slice(14), "base64"));
    if (e) out.push(e);
  }
  return out;
}

/** The pool's WSOL vault: its address and how much it moved. */
function vault(tx: ParsedTx, pool: string): { address: string; delta: bigint } | null {
  const pick = (list: TokenBalance[] | undefined) => list?.find((b) => b.owner === pool && b.mint === WSOL);
  const pre = pick(tx.meta?.preTokenBalances);
  const post = pick(tx.meta?.postTokenBalances);
  const ref = pre ?? post;
  if (!ref) return null;
  const address = tx.transaction.message.accountKeys[ref.accountIndex]?.pubkey ?? "";
  return { address, delta: BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0") };
}

/** SPL token transfers anywhere in the transaction (outer and inner). */
function tokenTransfers(tx: ParsedTx): { from: string; to: string; amount: bigint }[] {
  const out: { from: string; to: string; amount: bigint }[] = [];
  for (const ix of allInstructions(tx)) {
    if (ix.program !== "spl-token" || (ix.parsed?.type !== "transfer" && ix.parsed?.type !== "transferChecked")) continue;
    const info = ix.parsed.info ?? {};
    const amount = info.amount ?? (info.tokenAmount as { amount?: string } | undefined)?.amount;
    out.push({ from: String(info.source ?? ""), to: String(info.destination ?? ""), amount: big(amount) });
  }
  return out;
}

/**
 * One event → one swap. The invariant used is the money that stays in the pool:
 * buy  — into the vault = quote_amount_in_with_lp_fee; user pays that plus protocol and creator fees;
 * sell — out of the vault = quote_amount_out_without_lp_fee; user gets that minus protocol and creator fees.
 * It holds for `buy` and `buy_exact_quote_in` alike, whose other field names differ in meaning.
 */
export function swapFromEvent(e: DecodedEvent, tx: ParsedTx): Swap | null {
  const d = e.data;
  if (e.name !== "BuyEvent" && e.name !== "SellEvent") return null;
  const lpFee = big(d.lp_fee);
  const protocolFee = big(d.protocol_fee);
  const creatorFee = big(d.coin_creator_fee);
  const common = {
    pool: String(d.pool),
    user: String(d.user),
    lpFee,
    protocolFee,
    creatorFee,
    buybackFee: big(d.buyback_fee),
    cashback: big(d.cashback),
    bps: { lp: big(d.lp_fee_basis_points), protocol: big(d.protocol_fee_basis_points), creator: big(d.coin_creator_fee_basis_points) },
    protocolFeeRecipient: String(d.protocol_fee_recipient),
  };
  const v = vault(tx, common.pool);
  const userQuote = String(d.user_quote_token_account);
  const transfers = tokenTransfers(tx);
  const feesTotal = protocolFee + creatorFee;
  if (e.name === "BuyEvent") {
    const intoPool = big(d.quote_amount_in_with_lp_fee);
    const total = intoPool + protocolFee + creatorFee;
    return {
      ...common,
      side: "buy",
      instruction: String(d.ix_name ?? "buy"),
      baseAmount: big(d.base_amount_out),
      curveLamports: intoPool - lpFee,
      userLamports: total,
      eventReconciles: total === big(d.user_quote_amount_in) || total === big(d.quote_amount_in),
      ...settle(v, intoPool, transfers.filter((t) => t.from === userQuote && t.to !== v?.address), feesTotal),
    };
  }
  const curveOut = big(d.quote_amount_out);
  const fromPool = big(d.quote_amount_out_without_lp_fee);
  const received = fromPool - protocolFee - creatorFee;
  return {
    ...common,
    side: "sell",
    instruction: String(d.ix_name ?? "sell"),
    baseAmount: big(d.base_amount_in),
    curveLamports: curveOut,
    userLamports: received,
    eventReconciles: fromPool === curveOut - lpFee && received === big(d.user_quote_amount_out),
    ...settle(v, -fromPool, transfers.filter((t) => t.from === v?.address && t.to !== userQuote), feesTotal),
  };
}

/**
 * `swapFlow` is what the event says the vault should move: +into the pool on a buy, −out of it on a sell.
 * Whatever the vault moved beyond that is fee money it kept for later collection. Buy fees not kept are paid
 * by the user directly; sell fees not kept are paid out of the vault — either way they show up as transfers.
 */
function settle(
  v: { address: string; delta: bigint } | null,
  swapFlow: bigint,
  payoutTransfers: { to: string; amount: bigint }[],
  feesTotal: bigint,
): Pick<Swap, "payouts" | "heldInPool" | "feesAccounted"> {
  const payouts = payoutTransfers.map((t) => ({ to: t.to, lamports: t.amount }));
  if (!v) return { payouts, heldInPool: null, feesAccounted: null };
  const paid = payouts.reduce((sum, p) => sum + p.lamports, 0n);
  const heldInPool = v.delta - swapFlow;
  return { payouts, heldInPool, feesAccounted: paid + heldInPool === feesTotal };
}

function allInstructions(tx: ParsedTx): Instruction[] {
  return [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)];
}

export function breakdown(tx: ParsedTx, codec: IdlCodec): Breakdown {
  if (!tx.meta) throw new Error("transaction has no metadata");
  const keys = tx.transaction.message.accountKeys;
  const feePayer = keys[0]?.pubkey ?? "";
  const swaps = pumpswapEvents(tx, codec)
    .map((e) => swapFromEvent(e, tx))
    .filter((s): s is Swap => s !== null);
  const user = swaps[0]?.user ?? feePayer;
  const owned = new Set<string>();
  const ownedIdx = new Set<number>();
  for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    if (b.owner === user) {
      ownedIdx.add(b.accountIndex);
      const k = keys[b.accountIndex]?.pubkey;
      if (k) owned.add(k);
    }
  }

  const jitoTips: Transfer[] = [];
  const otherTransfers: Transfer[] = [];
  for (const ix of allInstructions(tx)) {
    if (ix.programId !== SYSTEM || ix.parsed?.type !== "transfer") continue;
    const info = ix.parsed.info ?? {};
    const from = String(info.source ?? "");
    const to = String(info.destination ?? "");
    const lamports = big(info.lamports);
    if (from !== user && from !== feePayer) continue;
    if (to === user || to === feePayer || owned.has(to)) continue; // wrapping SOL into the user's own token account
    (JITO_TIP_ACCOUNTS.has(to) ? jitoTips : otherTransfers).push({ to, lamports });
  }

  // Rent: lamports a token account of the user holds beyond its wrapped-SOL amount.
  const amountAt = (list: TokenBalance[] | undefined, i: number) => {
    const b = list?.find((x) => x.accountIndex === i);
    return b && b.mint === WSOL ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  let rentLamports = 0n;
  for (const i of ownedIdx) {
    const pre = BigInt(tx.meta.preBalances[i] ?? 0) - amountAt(tx.meta.preTokenBalances, i);
    const post = BigInt(tx.meta.postBalances[i] ?? 0) - amountAt(tx.meta.postTokenBalances, i);
    rentLamports += post - pre;
  }

  const base = 5_000n * BigInt(tx.transaction.signatures.length);
  const fee = BigInt(tx.meta.fee);
  return {
    signature: tx.transaction.signatures[0] ?? "",
    feePayer,
    networkFee: { base, priority: fee > base ? fee - base : 0n },
    jitoTips,
    otherTransfers,
    rentLamports,
    swaps,
  };
}

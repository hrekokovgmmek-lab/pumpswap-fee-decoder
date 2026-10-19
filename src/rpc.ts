import { maskSecrets } from "./config.ts";
import type { ParsedTx } from "./tx.ts";

export interface AccountData {
  owner: string;
  data: Buffer;
}

export interface LargestAccount {
  address: string;
  amount: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const RETRY_DELAYS_MS = [2_000, 5_000, 12_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Minimal Solana JSON-RPC client.
 *
 * Calls are serialized and spaced to stay under `maxRps` — public endpoints
 * answer bursts with 429. A 429, a 5xx or a network error is retried after
 * 2, 5 and 12 seconds; anything else fails at once.
 */
export class RpcClient {
  private chain: Promise<void> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly url: string,
    private readonly maxRps: number,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  private turn(): Promise<void> {
    const gap = 1000 / this.maxRps;
    const mine = this.chain.then(async () => {
      const delay = this.last + gap - Date.now();
      if (delay > 0) await this.wait(delay);
      this.last = Date.now();
    });
    this.chain = mine.catch(() => undefined);
    return mine;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.turn();
      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw new Error(`RPC ${method}: ${maskSecrets(String(err))}`);
        await this.wait(delay);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) throw new Error(`RPC ${method}: HTTP ${res.status}`);
        await this.wait(delay);
        continue;
      }
      if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
      return body.result as T;
    }
  }

  getTransaction(signature: string): Promise<ParsedTx | null> {
    return this.call<ParsedTx | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
    ]);
  }

  async getMultipleAccounts(keys: string[]): Promise<(AccountData | null)[]> {
    const r = await this.call<{ value: ({ owner: string; data: [string, string] } | null)[] }>("getMultipleAccounts", [
      keys,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    return r.value.map((v) => (v ? { owner: v.owner, data: Buffer.from(v.data[0], "base64") } : null));
  }

  async getTokenLargestAccounts(mint: string): Promise<LargestAccount[]> {
    const r = await this.call<{ value: LargestAccount[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    return r.value;
  }
}

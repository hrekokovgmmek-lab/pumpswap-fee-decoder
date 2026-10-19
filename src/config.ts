export interface Config {
  rpcUrl: string;
  rpcMaxRps: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rps = Number(env.RPC_MAX_RPS?.trim() || 2);
  if (!Number.isFinite(rps) || rps <= 0) throw new Error(`RPC_MAX_RPS must be a positive number, got "${env.RPC_MAX_RPS}"`);
  return { rpcUrl: env.RPC_URL?.trim() || "https://api.mainnet-beta.solana.com", rpcMaxRps: rps };
}

/** Hide API keys in any URL before it reaches a log line. */
export function maskSecrets(s: string): string {
  return s.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***");
}

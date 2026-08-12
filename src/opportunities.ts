import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { BexQuoteScanner, WBERA } from "./bex.js";
import type { BerachainClients } from "./chain.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import type { NetworkDiscoverySnapshot } from "./discovery.js";
import { KodiakQuoteScanner } from "./kodiak.js";

const INPUT_WBERA = 10_000_000_000_000_000n; // 0.01 WBERA: read-only discovery not tied to wallet balance.

export type OpportunitySummary = {
  observedAt: string;
  blockNumber: string;
  kind: "bex-cycle";
  tokenPath: string[];
  inputWbera: string;
  outputWbera: string;
  grossUsd: number;
  estimatedGasUsd: number;
  expectedNetUsd: number;
  qualified: boolean;
  gate: { qualifiedCount: number; ready: boolean };
  /**
   * A cross-venue price discrepancy is discovery only.  It is deliberately not
   * counted as a qualified executable opportunity: a future AtomicExecutor
   * must reproduce both legs and the repayment on-chain in one transaction.
   */
  crossVenue?: CrossVenueSummary;
};

export type CrossVenueSummary = {
  observedAt: string;
  route: "bex-then-kodiak" | "kodiak-then-bex";
  inputWbera: string;
  outputWbera: string;
  grossUsd: number;
  estimatedGasUsd: number;
  expectedNetUsd: number;
  indicative: boolean;
  bexBlockNumber: string;
  kodiakRoute: string;
  reason: string;
};

/**
 * Reads BEX cycles through every eligible discovered token pair at a single
 * real mainnet block. It is evidence collection only; no route calldata is
 * sent to the executor.
 */
export class OpportunityScanner {
  private timer?: NodeJS.Timeout;
  private current?: OpportunitySummary;
  private previousQualified = false;
  private readonly listeners = new Set<(summary: OpportunitySummary) => void>();
  private readonly kodiak: KodiakQuoteScanner;

  constructor(private readonly config: Config, private readonly chain: BerachainClients, private readonly db: Database, private readonly bex: BexQuoteScanner, private readonly logger: Logger) {
    this.kodiak = new KodiakQuoteScanner(config, db, logger);
  }
  get latest() { return this.current; }
  onQualifiedChange(listener: (summary: OpportunitySummary) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async scan(): Promise<void> {
    const blockNumber = await this.chain.secondary.getBlockNumber();
    const [gasPriceWei, beraUsd, discovery] = await Promise.all([
      this.chain.secondary.getGasPrice(), this.chain.tokenPrice(WBERA), this.db.latestMarketSnapshot<NetworkDiscoverySnapshot>("network-discovery", "bex-universe")
    ]);
    const assets = (discovery?.tokenUniverse ?? []).filter((token) => token.address.toLowerCase() !== WBERA.toLowerCase() && Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36).slice(0, 6);
    const routes = routePaths(assets);
    const results = await Promise.all(routes.map((path) => this.quoteCycle(path, blockNumber, gasPriceWei, beraUsd)));
    const viable = results.filter((result): result is CycleResult => result !== undefined);
    if (!viable.length) throw new Error("No discovered BEX cycle returned a complete same-block quote");
    for (const result of viable) await this.persist(result, blockNumber);
    const best = viable.reduce((left, right) => right.expectedNetUsd > left.expectedNetUsd ? right : left);
    const gate = await this.db.opportunityGate();
    const bexHoneyCycle = viable.find((result) => result.path.length === 1 && result.path[0].address.toLowerCase() === this.config.HONEY_ADDRESS.toLowerCase());
    const crossVenue = bexHoneyCycle ? await this.crossVenueScan(blockNumber, gasPriceWei, beraUsd, bexHoneyCycle) : undefined;
    this.current = { observedAt: new Date().toISOString(), blockNumber: blockNumber.toString(), kind: "bex-cycle", tokenPath: best.path.map((token) => token.symbol), inputWbera: INPUT_WBERA.toString(), outputWbera: best.outputWbera.toString(), grossUsd: best.grossUsd, estimatedGasUsd: best.estimatedGasUsd, expectedNetUsd: best.expectedNetUsd, qualified: best.qualified, gate, crossVenue };
    if (best.qualified && best.qualified !== this.previousQualified) for (const listener of this.listeners) listener(this.current);
    this.previousQualified = best.qualified;
    this.logger.info({ ...this.current, pathsChecked: routes.length, pathsQuoted: viable.length }, "same-block BEX opportunity scan saved");
  }

  start(intervalMs = this.config.OPPORTUNITY_SCAN_INTERVAL_MS): void {
    // Discovery starts with this service. Give its first real GraphQL snapshot a
    // short head start rather than treating an empty pre-start cache as a failed
    // market scan.
    this.timer = setTimeout(() => {
      void this.scan().catch((error) => this.logger.error({ err: error }, "initial opportunity scan failed"));
      this.timer = setInterval(() => void this.scan().catch((error) => this.logger.error({ err: error }, "opportunity scan failed")), intervalMs);
    }, 5_000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  private async quoteCycle(path: Asset[], blockNumber: bigint, gasPriceWei: bigint, beraUsd: number): Promise<CycleResult | undefined> {
    try {
      let amount = INPUT_WBERA;
      const quotes = [];
      const complete = [{ address: WBERA, symbol: "WBERA", decimals: 18 }, ...path, { address: WBERA, symbol: "WBERA", decimals: 18 }];
      for (let index = 0; index < complete.length - 1; index += 1) {
        const quote = await this.bex.quoteExactIn({ tokenInAddress: complete[index].address, tokenInDecimals: complete[index].decimals, tokenOutAddress: complete[index + 1].address, tokenOutDecimals: complete[index + 1].decimals, amountIn: amount, blockNumber });
        quotes.push(quote); amount = BigInt(quote.amountOut);
      }
      const outputWbera = amount;
      const grossUsd = Number(outputWbera - INPUT_WBERA) / 1e18 * beraUsd;
      const gasUnits = path.length === 1 ? 350_000n : 450_000n;
      const estimatedGasUsd = Number(gasUnits * gasPriceWei) / 1e18 * beraUsd;
      const expectedNetUsd = grossUsd - estimatedGasUsd;
      return { path, quotes, outputWbera, grossUsd, estimatedGasUsd, expectedNetUsd, qualified: expectedNetUsd >= Math.max(estimatedGasUsd * 3, 0.03), gasPriceWei, beraUsd, gasUnits };
    } catch {
      return undefined;
    }
  }

  private async persist(result: CycleResult, blockNumber: bigint): Promise<void> {
    const fingerprint = createHash("sha256").update(JSON.stringify({ block: blockNumber.toString(), path: result.path.map((token) => token.address), input: INPUT_WBERA.toString(), output: result.outputWbera.toString(), pools: result.quotes.map((quote) => quote.routePools) })).digest("hex");
    const reason = result.qualified ? "same-block route exceeds the absolute and gas×3 discovery threshold; still needs contract-level preflight" : `net $${result.expectedNetUsd.toFixed(6)} does not exceed max($0.03, gas×3 $${(result.estimatedGasUsd * 3).toFixed(6)})`;
    await this.db.saveOpportunityCandidate({ fingerprint, kind: "bex-cycle", protocol: "BEX", blockNumber, qualified: result.qualified, expectedNetProfitUsd: result.expectedNetUsd, reason, evidence: { blockNumber: blockNumber.toString(), tokenPath: ["WBERA", ...result.path.map((token) => token.symbol), "WBERA"], quotes: result.quotes, gasPriceWei: result.gasPriceWei.toString(), beraUsd: result.beraUsd, methodology: `same-block BEX SOR query; ${result.gasUnits}-gas conservative atomic estimate` } });
  }

  private async crossVenueScan(blockNumber: bigint, gasPriceWei: bigint, beraUsd: number, bexHoneyCycle: CycleResult): Promise<CrossVenueSummary | undefined> {
    try {
      // Reuse the BEX WBERA->HONEY read from the enclosing, fixed-block scan.
      // This avoids making a second, redundant call to an external SOR API;
      // one incomplete response is grounds to drop the signal, not to retry a
      // different block and accidentally call it atomic evidence.
      const bexForward = bexHoneyCycle.quotes[0];
      const kodiakBack = await this.kodiak.quoteExactIn({ tokenIn: this.config.HONEY_ADDRESS, tokenOut: WBERA, amountIn: BigInt(bexForward.amountOut) });
      const variants = [{ route: "bex-then-kodiak" as const, outputWbera: kodiakBack.amountOut, kodiakRoute: kodiakBack.route }];
      const gasUsd = Number(700_000n * gasPriceWei) / 1e18 * beraUsd;
      const best = variants.reduce((left, right) => right.outputWbera > left.outputWbera ? right : left);
      const grossUsd = Number(best.outputWbera - INPUT_WBERA) / 1e18 * beraUsd;
      const expectedNetUsd = grossUsd - gasUsd;
      const threshold = Math.max(gasUsd * 3, 0.03);
      const summary: CrossVenueSummary = {
        observedAt: new Date().toISOString(), route: best.route, inputWbera: INPUT_WBERA.toString(), outputWbera: best.outputWbera.toString(), grossUsd, estimatedGasUsd: gasUsd, expectedNetUsd,
        indicative: expectedNetUsd >= threshold, bexBlockNumber: blockNumber.toString(), kodiakRoute: best.kodiakRoute,
        reason: expectedNetUsd >= threshold
          ? "Indicative cross-venue spread exceeds discovery threshold but is not executable until atomically reproduced on-chain."
          : `Indicative cross-venue net $${expectedNetUsd.toFixed(6)} does not exceed max($0.03, gas×3 $${threshold.toFixed(6)}).`
      };
      await this.db.saveMarketSnapshot("cross-venue", "bex-kodiak-wbera-honey", summary);
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (message.includes("source cooldown")) this.logger.debug({ message }, "cross-venue source remains excluded during cooldown");
      else this.logger.warn({ err: error }, "cross-venue read-only scan unavailable");
      return undefined;
    }
  }
}

type Asset = { address: string; symbol: string; decimals: number };
type CycleResult = { path: Asset[]; quotes: Awaited<ReturnType<BexQuoteScanner["quoteExactIn"]>>[]; outputWbera: bigint; grossUsd: number; estimatedGasUsd: number; expectedNetUsd: number; qualified: boolean; gasPriceWei: bigint; beraUsd: number; gasUnits: bigint };

function routePaths(assets: Asset[]): Asset[][] {
  const paths: Asset[][] = assets.map((asset) => [asset]);
  for (const first of assets) for (const second of assets) if (first.address.toLowerCase() !== second.address.toLowerCase()) paths.push([first, second]);
  return paths;
}

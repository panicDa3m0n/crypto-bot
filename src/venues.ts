import type { Database } from "./db.js";
import type { Config } from "./config.js";

/** Standard families the unified sensorium knows how to read. Adding a venue of an
 * existing type needs no new code — only a row in the registry. */
export type VenueType = "uni-v3" | "uni-v2" | "balancer" | "morpho" | "dolomite" | "erc4626" | "reward-vault";

export type Venue = { id: string; name: string; type: VenueType; address: string; meta: Record<string, unknown>; enabled: boolean; addedBy: string };

/**
 * Seed of the main Monad profit surfaces, by standard type. Scarlet extends this
 * herself with add_venue as she explores; we only prime the pump. Uniswap V4, Kuru
 * (CLOB) and Curve are outside our readers — reach them via call_contract / the 0x
 * aggregator, and add a same-standard V3/V2 DEX (e.g. PancakeSwap v3) as a second
 * price for cross-venue arbitrage once its addresses are confirmed on-chain.
 */
/** The primary readable AMM is seeded from CONFIG (factory/router/quoter), so a chain switch
 * (Monad→Base) needs no code change. Extra chain-specific venues (a second V3 for cross-venue
 * arb, Morpho, etc.) are added by Scarlet with add_venue or via VENUE_EXTRA_JSON. */
export function venueSeed(config: Config): Array<{ id: string; name: string; type: VenueType; address: string; meta?: Record<string, unknown> }> {
  const base: Array<{ id: string; name: string; type: VenueType; address: string; meta?: Record<string, unknown> }> = [
    { id: "uniswap-v3", name: `Uniswap V3 (${config.CHAIN_NAME})`, type: "uni-v3", address: config.DEX_FACTORY, meta: { role: "factory", swapRouter: config.DEX_ROUTER, quoter: config.DEX_QUOTER, note: "primary readable V3 AMM (from config); new tokens graduate here" } }
  ];
  if (config.VENUE_EXTRA_JSON) {
    try { const extra = JSON.parse(config.VENUE_EXTRA_JSON) as typeof base; if (Array.isArray(extra)) base.push(...extra); } catch { /* ignore malformed */ }
  }
  return base;
}

/** The registry of profit surfaces. Scarlet reads it and grows it; the sensorium consumes it. */
export class VenueRegistry {
  private cache: Venue[] = [];
  constructor(private readonly db: Database, private readonly config: Config) {}

  async seed(): Promise<void> {
    for (const v of venueSeed(this.config)) await this.db.upsertVenue({ ...v, addedBy: "seed" }).catch(() => undefined);
    await this.hydrate();
  }

  async hydrate(): Promise<void> { this.cache = (await this.db.listVenues()) as Venue[]; }
  get all(): Venue[] { return this.cache; }
  byType(type: VenueType): Venue[] { return this.cache.filter((v) => v.type === type); }

  async add(v: { id: string; name: string; type: VenueType; address: string; meta?: Record<string, unknown> }): Promise<void> {
    await this.db.upsertVenue({ ...v, addedBy: "scarlet" });
    await this.hydrate();
  }

  async remove(id: string): Promise<boolean> {
    const ok = await this.db.removeVenue(id);
    await this.hydrate();
    return ok;
  }
}

export const VENUE_TYPES: VenueType[] = ["uni-v3", "uni-v2", "balancer", "morpho", "dolomite", "erc4626", "reward-vault"];

/** Prompt-safe view of the registry for Scarlet's briefing. */
export function venuesContext(venues: Venue[]): unknown {
  return {
    note: "The profit surfaces you can operate. Add a new one with add_venue when you discover it (type must be one of: " + VENUE_TYPES.join(", ") + "); remove a dead/invalid one with remove_venue.",
    venues: venues.map((v) => ({ id: v.id, name: v.name, type: v.type, address: v.address, meta: v.meta }))
  };
}

import { BendPositionsCollector, BendPositionsStore } from "./bend.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const addressIndex = process.argv.indexOf("--address");
const walletAddress = addressIndex >= 0 ? process.argv[addressIndex + 1] : undefined;
if (!walletAddress) throw new Error("Usage: bend-scan --address 0x...");
const config = loadNetworkConfig();
const snapshot = await new BendPositionsCollector(
  new BerachainRpc(config.berachainRpcUrl), new BerachainRpc(config.berachainSecondaryRpcUrl),
  new ProtocolRegistryStore(config.dataDirectory), new BendPositionsStore(config.dataDirectory)
).collect(walletAddress);
process.stdout.write(`${JSON.stringify({
  id: snapshot.id, observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress,
  network: snapshot.network, integrity: snapshot.integrity, activeMarketCount: snapshot.activeMarketCount,
  markets: snapshot.markets.map((market) => ({ id: market.id, label: market.label, state: market.state, marketParams: market.marketParams, derived: market.derived, error: market.error })), coverage: snapshot.coverage
}, null, 2)}\n`);

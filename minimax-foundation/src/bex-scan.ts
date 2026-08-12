import { BexCollector, BexStore } from "./bex.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const addressIndex = process.argv.indexOf("--address"); const walletAddress = addressIndex >= 0 ? process.argv[addressIndex + 1] : undefined;
const limitIndex = process.argv.indexOf("--limit"); const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 50;
if (!walletAddress) throw new Error("Usage: bex-scan --address 0x... [--limit 50]");
const config = loadNetworkConfig();
const snapshot = await new BexCollector(new BerachainRpc(config.berachainRpcUrl), new BerachainRpc(config.berachainSecondaryRpcUrl), new ProtocolRegistryStore(config.dataDirectory), new BexStore(config.dataDirectory)).collect(walletAddress, limit);
process.stdout.write(`${JSON.stringify({ id: snapshot.id, observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, network: snapshot.network, api: snapshot.api, integrity: snapshot.integrity, walletPositions: snapshot.walletPositions, poolSummary: snapshot.pools.map((pool) => ({ id: pool.id, name: pool.name, state: pool.state, totalLiquidity: pool.api.totalLiquidity, apiTokenSetMatches: pool.onchain?.apiTokenSetMatches, error: pool.error })), coverage: snapshot.coverage }, null, 2)}\n`);

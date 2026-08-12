import { KodiakPositionsCollector, KodiakPositionsStore } from "./kodiak.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const index = process.argv.indexOf("--address"); const walletAddress = index >= 0 ? process.argv[index + 1] : undefined;
if (!walletAddress) throw new Error("Usage: kodiak-scan --address 0x...");
const config = loadNetworkConfig();
const snapshot = await new KodiakPositionsCollector(new BerachainRpc(config.berachainRpcUrl), new BerachainRpc(config.berachainSecondaryRpcUrl), new ProtocolRegistryStore(config.dataDirectory), new KodiakPositionsStore(config.dataDirectory)).collect(walletAddress);
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);

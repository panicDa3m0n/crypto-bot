import { BexStore } from "./bex.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { PortfolioStore } from "./portfolio.js";
import { WalletValuationCollector, WalletValuationStore } from "./valuation.js";

const index = process.argv.indexOf("--address"); const walletAddress = index >= 0 ? process.argv[index + 1] : undefined;
if (!walletAddress) throw new Error("Usage: valuation-scan --address 0x...");
const config = loadNetworkConfig();
const snapshot = await new WalletValuationCollector(new BerachainRpc(config.berachainRpcUrl), new BerachainRpc(config.berachainSecondaryRpcUrl), new PortfolioStore(config.dataDirectory), new BexStore(config.dataDirectory), config.dataDirectory, new WalletValuationStore(config.dataDirectory)).collect(walletAddress);
process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);

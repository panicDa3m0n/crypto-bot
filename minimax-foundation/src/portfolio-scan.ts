import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { PortfolioCollector, PortfolioStore } from "./portfolio.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const addressIndex = process.argv.indexOf("--address");
const walletAddress = addressIndex >= 0 ? process.argv[addressIndex + 1] : undefined;
if (!walletAddress) throw new Error("Usage: portfolio-scan --address 0x...");

const config = loadNetworkConfig();
const snapshot = await new PortfolioCollector(
  new BerachainRpc(config.berachainRpcUrl),
  new BerachainRpc(config.berachainSecondaryRpcUrl),
  new ProtocolRegistryStore(config.dataDirectory),
  new PortfolioStore(config.dataDirectory)
).collect(walletAddress);

process.stdout.write(`${JSON.stringify({
  id: snapshot.id, observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress,
  network: snapshot.network, integrity: snapshot.integrity, nativeBera: snapshot.nativeBera,
  nonce: snapshot.nonce, gas: snapshot.gas,
  tokens: snapshot.tokens.map((token) => ({ address: token.address, symbol: token.symbol, balanceFormatted: token.balanceFormatted, balanceState: token.balanceState })),
  allowances: { checkedPairs: snapshot.allowances.checkedPairs, failures: snapshot.allowances.failures, nonZero: snapshot.allowances.nonZero },
  positions: snapshot.positions, valuation: snapshot.valuation, coverage: snapshot.coverage
}, null, 2)}\n`);

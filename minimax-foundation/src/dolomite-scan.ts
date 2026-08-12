import { DolomiteAccountCollector, DolomiteAccountStore } from "./dolomite.js";
import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { ProtocolRegistryStore } from "./protocol-registry.js";

const addressIndex = process.argv.indexOf("--address");
const walletAddress = addressIndex >= 0 ? process.argv[addressIndex + 1] : undefined;
const accountIndex = process.argv.indexOf("--account");
const accountNumber = accountIndex >= 0 ? process.argv[accountIndex + 1] : "0";
if (!walletAddress) throw new Error("Usage: dolomite-scan --address 0x... [--account 0]");
const config = loadNetworkConfig();
const snapshot = await new DolomiteAccountCollector(
  new BerachainRpc(config.berachainRpcUrl), new BerachainRpc(config.berachainSecondaryRpcUrl),
  new ProtocolRegistryStore(config.dataDirectory), new DolomiteAccountStore(config.dataDirectory)
).collect(walletAddress, accountNumber);
process.stdout.write(`${JSON.stringify({ id: snapshot.id, observedAt: snapshot.observedAt, walletAddress: snapshot.walletAddress, accountNumber: snapshot.accountNumber, network: snapshot.network, integrity: snapshot.integrity, accountStatus: snapshot.accountStatus, balances: snapshot.balances, values: snapshot.values, coverage: snapshot.coverage }, null, 2)}\n`);

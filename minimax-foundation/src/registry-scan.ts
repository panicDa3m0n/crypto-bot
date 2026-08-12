import { BerachainRpc } from "./berachain-rpc.js";
import { loadNetworkConfig } from "./config.js";
import { ProtocolRegistryCollector, ProtocolRegistryStore } from "./protocol-registry.js";

const config = loadNetworkConfig();
const collector = new ProtocolRegistryCollector(
  new BerachainRpc(config.berachainRpcUrl),
  new BerachainRpc(config.berachainSecondaryRpcUrl),
  new ProtocolRegistryStore(config.dataDirectory)
);

const snapshot = await collector.collect();
process.stdout.write(`${JSON.stringify({
  id: snapshot.id,
  observedAt: snapshot.observedAt,
  network: snapshot.network,
  summary: snapshot.summary,
  protocols: snapshot.protocols.map((protocol) => ({
    id: protocol.id,
    status: protocol.status,
    verified: protocol.candidates.filter((candidate) => candidate.verification.state === "verified-dual-rpc").length,
    totalCandidates: protocol.candidates.length
  }))
}, null, 2)}\n`);

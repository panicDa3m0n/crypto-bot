import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BerachainRpc } from "./berachain-rpc.js";

export type ProtocolId = "bex" | "bend" | "beraborrow" | "dolomite" | "bulla" | "kodiak" | "infrared" | "origami";
export type ContractRole = "core" | "factory" | "router" | "vault" | "oracle" | "market" | "token" | "position-manager" | "quoter";
export type SourceTrust = "berachain-official" | "project-official" | "pending";
export type VerificationState = "verified-dual-rpc" | "no-code" | "rpc-disagreement" | "rpc-unavailable";

export type DocumentationSource = { title: string; url: string; trust: SourceTrust };
export type ContractSeed = { label: string; address: string; role: ContractRole; source: DocumentationSource };
export type ProtocolDefinition = {
  id: ProtocolId;
  name: string;
  description: string;
  sources: DocumentationSource[];
  candidates: ContractSeed[];
  discoveryNotes: string[];
};
export type VerifiedContract = ContractSeed & {
  verification: {
    state: VerificationState;
    primaryCodeSha256?: string;
    secondaryCodeSha256?: string;
    byteLength?: number;
    error?: string;
  };
};
export type ProtocolObservation = Omit<ProtocolDefinition, "candidates"> & {
  status: "verified" | "partial" | "source-pending" | "rejected";
  candidates: VerifiedContract[];
};
export type ProtocolRegistrySnapshot = {
  schemaVersion: 1;
  id: string;
  observedAt: string;
  network: { chainId: string; primaryHead: string; secondaryHead: string; headDifference: string };
  protocols: ProtocolObservation[];
  summary: { protocolCount: number; verifiedContracts: number; unavailableContracts: number; rejectedContracts: number; sourcePendingProtocols: ProtocolId[] };
};

const beraDocs = (title: string, url: string): DocumentationSource => ({ title, url, trust: "berachain-official" });
const projectDocs = (title: string, url: string): DocumentationSource => ({ title, url, trust: "project-official" });
const pending = (title: string, url: string): DocumentationSource => ({ title, url, trust: "pending" });

/**
 * Published protocol anchors only. An address becomes usable by Scarlet only
 * after this collector finds identical non-empty bytecode through both RPCs.
 * BEX, Bulla and Origami intentionally have no guessed addresses here.
 */
export const protocolCatalog: ProtocolDefinition[] = [
  {
    id: "bex", name: "BEX", description: "Berachain exchange and PoL ecosystem.",
    sources: [beraDocs("BEX deployed contracts", "https://docs.berachain.com/build/bex/deployed-contracts"), beraDocs("BEX SDK", "https://docs.berachain.com/build/bex/sdk/reference"), beraDocs("Reward Vaults", "https://docs.berachain.com/general/proof-of-liquidity/reward-vaults")],
    candidates: [
      { label: "BEX Vault", address: "0x4Be03f781C497A489E3cB0287833452cA9B9E80B", role: "core", source: beraDocs("BEX deployed contracts", "https://docs.berachain.com/build/bex/deployed-contracts") },
      { label: "BEX Balancer Helpers", address: "0x5083737EC75a728c265BE578C9d0d5333a2c5951", role: "core", source: beraDocs("BEX deployed contracts", "https://docs.berachain.com/build/bex/deployed-contracts") },
      { label: "BEX Weighted Pool Factory", address: "0xa966fA8F2d5B087FFFA499C0C1240589371Af409", role: "factory", source: beraDocs("BEX deployed contracts", "https://docs.berachain.com/build/bex/deployed-contracts") }
    ],
    discoveryNotes: ["Discover pools and reward vaults from the official BEX API, then reconfirm each pool's code and token balances through the verified BEX Vault.", "Treat API results as candidates and reconfirm all balances, bytecode and calls through RPC."]
  },
  {
    id: "bend", name: "Bend", description: "Berachain lending layer built around Morpho markets and protocol oracle data.",
    sources: [beraDocs("Bend deployed contracts", "https://docs.berachain.com/build/bend/deployed-contracts"), beraDocs("Bend oracle", "https://docs.berachain.com/bend/learn/oracle")],
    candidates: [
      { label: "Morpho", address: "0x24147243f9c08d835C218Cda1e135f8dFD0517D0", role: "core", source: beraDocs("Bend deployed contracts", "https://docs.berachain.com/build/bend/deployed-contracts") }
    ],
    discoveryNotes: ["Markets, health factors and liquidation eligibility require their market-specific oracle and exact on-chain state."]
  },
  {
    id: "beraborrow", name: "Beraborrow", description: "Collateralized borrowing and stability-pool protocol.",
    sources: [projectDocs("Beraborrow contract addresses", "https://beraborrow.gitbook.io/docs/additional-resources/contract-addresses")],
    candidates: [
      { label: "Beraborrow Core", address: "0x12347cAF4300B1c4a9bF0Ae7DE2531A2BCFB93E9", role: "core", source: projectDocs("Beraborrow contract addresses", "https://beraborrow.gitbook.io/docs/additional-resources/contract-addresses") },
      { label: "Borrower Operations", address: "0xDB32cA8f3bB099A76D4Ec713a2c2AACB3d8e84B9", role: "core", source: projectDocs("Beraborrow contract addresses", "https://beraborrow.gitbook.io/docs/additional-resources/contract-addresses") },
      { label: "Price Feed", address: "0xa686DC84330b1B3787816de2DaCa485D305c8589", role: "oracle", source: projectDocs("Beraborrow contract addresses", "https://beraborrow.gitbook.io/docs/additional-resources/contract-addresses") },
      { label: "Liquidation Manager", address: "0x965dA3f96dCBfcCF3C1d0603e76356775b5afD2E", role: "core", source: projectDocs("Beraborrow contract addresses", "https://beraborrow.gitbook.io/docs/additional-resources/contract-addresses") },
      { label: "NECT", address: "0x1cE0a25D13CE4d52071aE7e02Cf1F6606F4C79d3", role: "token", source: projectDocs("Beraborrow contract addresses", "https://beraborrow.gitbook.io/docs/additional-resources/contract-addresses") }
    ],
    discoveryNotes: ["Collateral-specific vaults and dens must be enumerated from the published factory/core state before any position analysis."]
  },
  {
    id: "dolomite", name: "Dolomite", description: "Money market and margin protocol.",
    sources: [projectDocs("Dolomite immutable core", "https://docs.dolomite.io/smart-contract-addresses/core-immutable"), projectDocs("Dolomite markets", "https://docs.dolomite.io/markets")],
    candidates: [
      { label: "Dolomite Margin", address: "0x003Ca23Fd5F0ca87D01F6eC6CD14A8AE60c2b97D", role: "core", source: projectDocs("Dolomite immutable core", "https://docs.dolomite.io/smart-contract-addresses/core-immutable") },
      { label: "WBERA market token", address: "0x6969696969696969696969696969696969696969", role: "token", source: projectDocs("Dolomite markets", "https://docs.dolomite.io/markets") },
      { label: "USDC.e market token", address: "0x549943e04f40284185054145c6E4e9568C1D3241", role: "token", source: projectDocs("Dolomite markets", "https://docs.dolomite.io/markets") },
      { label: "HONEY market token", address: "0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce", role: "token", source: projectDocs("Dolomite markets", "https://docs.dolomite.io/markets") }
    ],
    discoveryNotes: ["Market ID, price, account balances and risk parameters are read from Dolomite Margin; token lists alone are insufficient."]
  },
  {
    id: "bulla", name: "Bulla", description: "Algebra Integral-based DEX documented for Berachain.",
    sources: [projectDocs("Bulla documentation", "https://docs.bulla.exchange/")], candidates: [],
    discoveryNotes: ["No deployment address is seeded until it is published by Bulla or independently discovered and verified from a protocol-owned source."]
  },
  {
    id: "kodiak", name: "Kodiak", description: "DEX, concentrated-liquidity and managed-liquidity ecosystem.",
    sources: [projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts"), projectDocs("Kodiak Islands factory", "https://documentation.kodiak.finance/developers/kodiak-islands/smart-contract-reference/kodiak-island-factory")],
    candidates: [
      { label: "Uniswap V3 Factory", address: "0xD84CBf0B02636E7f53dB9E5e45A616E05d710990", role: "factory", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Uniswap V2 Factory", address: "0x5e705e184d233ff2a7cb1553793464a9d0c3028f", role: "factory", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Swap Router 02", address: "0xe301E48F77963D3F7DbD2a4796962Bd7f3867Fb4", role: "router", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Quoter V2", address: "0x644C8D6E501f7C994B74F5ceA96abe65d0BA662B", role: "quoter", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Position Manager", address: "0xFE5E8C83FFE4d9627A75EaA7Fee864768dB989bD", role: "position-manager", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Island Factory", address: "0x5261c5A5f08818c08Ed0Eb036d9575bA1E02c1d6", role: "factory", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Island Router", address: "0x679a7C63FC83b6A4D9C1F931891d705483d4791F", role: "router", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") },
      { label: "Kodiak Rewards", address: "0xBc3dfE5eE6bCE8b301a3661B3528a5c605eAf6aF", role: "vault", source: projectDocs("Kodiak contracts", "https://documentation.kodiak.finance/overview/kodiak-contracts") }
    ],
    discoveryNotes: ["Pools and Islands are discovered from verified factory events/state; quotes remain non-authoritative until read/simulated on chain."]
  },
  {
    id: "infrared", name: "Infrared", description: "Liquid staking and Proof-of-Liquidity infrastructure.",
    sources: [projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments"), projectDocs("Infrared tokens", "https://infrared.finance/docs/tokens")],
    candidates: [
      { label: "Infrared core", address: "0xb71b3DaEA39012Fb0f2B14D2a9C86da9292fC126", role: "core", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") },
      { label: "iBGT", address: "0xac03CABA51e17c86c921E1f6CBFBdC91F8BB2E6b", role: "token", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") },
      { label: "iBGT Vault", address: "0x75F3Be06b02E235f6d0E7EF2D462b29739168301", role: "vault", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") },
      { label: "iBERA", address: "0x9b6761bf2397Bb5a6624a856cC84A3A14Dcd3fe5", role: "token", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") },
      { label: "Depositor", address: "0x04CddC538ea65908106416986aDaeCeFD4CAB7D7", role: "core", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") },
      { label: "Withdrawor Lite", address: "0x8c0E122960dc2E97dc0059c07d6901Dce72818E1", role: "core", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") },
      { label: "IR", address: "0xa1b644aec990ad6023811ced36e6a2d6d128c7c9", role: "token", source: projectDocs("Infrared contract deployments", "https://infrared.finance/docs/developers/contract-deployments") }
    ],
    discoveryNotes: ["Validator, reward-vault and delegate data must be observed from protocol state before assessing rewards or lock-up risk."]
  },
  {
    id: "origami", name: "Origami", description: "Automated leverage protocol; Berachain deployment status is not assumed.",
    sources: [pending("Origami documentation", "https://docs.origami.finance/")], candidates: [],
    discoveryNotes: ["Keep source-pending: the general documentation does not establish a Berachain deployment address. Do not infer one from another network."]
  }
];

export class ProtocolRegistryStore {
  constructor(private readonly dataDirectory: string) {}

  async save(snapshot: ProtocolRegistrySnapshot): Promise<void> {
    await atomicJson(this.snapshotPath(snapshot.id), snapshot);
    await atomicJson(this.latestPath(), snapshot);
  }

  async latest(): Promise<ProtocolRegistrySnapshot | undefined> {
    try { return JSON.parse(await readFile(this.latestPath(), "utf8")) as ProtocolRegistrySnapshot; }
    catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; }
  }

  private snapshotPath(id: string) { return join(this.dataDirectory, "protocol-registry", "snapshots", `${id}.json`); }
  private latestPath() { return join(this.dataDirectory, "protocol-registry", "latest.json"); }
}

export class ProtocolRegistryCollector {
  constructor(private readonly primary: BerachainRpc, private readonly secondary: BerachainRpc, private readonly store: ProtocolRegistryStore) {}

  async collect(): Promise<ProtocolRegistrySnapshot> {
    const [primaryHead, secondaryHead] = await Promise.all([this.primary.chainHead(), this.secondary.chainHead()]);
    if (primaryHead.chainId !== secondaryHead.chainId) throw new Error("Primary and secondary RPC chain IDs disagree.");
    const protocols = await Promise.all(protocolCatalog.map(async (protocol) => {
      const candidates = await mapConcurrent(protocol.candidates, 3, (candidate) => this.verify(candidate));
      return { ...protocol, candidates, status: protocolStatus(protocol, candidates) } satisfies ProtocolObservation;
    }));
    const all = protocols.flatMap((protocol) => protocol.candidates);
    const snapshot: ProtocolRegistrySnapshot = {
      schemaVersion: 1,
      id: `registry_${randomUUID()}`,
      observedAt: new Date().toISOString(),
      network: {
        chainId: primaryHead.chainId,
        primaryHead: primaryHead.blockNumber,
        secondaryHead: secondaryHead.blockNumber,
        headDifference: absoluteDifference(primaryHead.blockNumber, secondaryHead.blockNumber).toString()
      },
      protocols,
      summary: {
        protocolCount: protocols.length,
        verifiedContracts: all.filter((candidate) => candidate.verification.state === "verified-dual-rpc").length,
        unavailableContracts: all.filter((candidate) => candidate.verification.state === "rpc-unavailable").length,
        rejectedContracts: all.filter((candidate) => candidate.verification.state === "no-code" || candidate.verification.state === "rpc-disagreement").length,
        sourcePendingProtocols: protocols.filter((protocol) => protocol.status === "source-pending").map((protocol) => protocol.id)
      }
    };
    await this.store.save(snapshot);
    return snapshot;
  }

  private async verify(candidate: ContractSeed): Promise<VerifiedContract> {
    try {
      const [primaryCode, secondaryCode] = await Promise.all([this.primary.code(candidate.address), this.secondary.code(candidate.address)]);
      const primaryHash = sha256(primaryCode); const secondaryHash = sha256(secondaryCode);
      if (primaryCode === "0x" || secondaryCode === "0x") return { ...candidate, verification: { state: "no-code", primaryCodeSha256: primaryHash, secondaryCodeSha256: secondaryHash } };
      if (primaryCode !== secondaryCode) return { ...candidate, verification: { state: "rpc-disagreement", primaryCodeSha256: primaryHash, secondaryCodeSha256: secondaryHash, byteLength: (primaryCode.length - 2) / 2 } };
      return { ...candidate, verification: { state: "verified-dual-rpc", primaryCodeSha256: primaryHash, secondaryCodeSha256: secondaryHash, byteLength: (primaryCode.length - 2) / 2 } };
    } catch (error) {
      return { ...candidate, verification: { state: "rpc-unavailable", error: error instanceof Error ? error.message : String(error) } };
    }
  }
}

/** Compact, prompt-safe statement of what was actually verified. */
export function registryContext(snapshot: ProtocolRegistrySnapshot | undefined): unknown {
  if (!snapshot) return { status: "not-collected", instruction: "Use get_protocol_registry after a registry scan; do not guess protocol deployments." };
  return {
    observedAt: snapshot.observedAt, network: snapshot.network, summary: snapshot.summary,
    protocols: snapshot.protocols.map((protocol) => ({ id: protocol.id, name: protocol.name, status: protocol.status, verifiedContracts: protocol.candidates.filter((candidate) => candidate.verification.state === "verified-dual-rpc").map((candidate) => ({ label: candidate.label, address: candidate.address, role: candidate.role })), discoveryNotes: protocol.discoveryNotes }))
  };
}

function protocolStatus(protocol: ProtocolDefinition, candidates: VerifiedContract[]): ProtocolObservation["status"] {
  if (protocol.sources.every((source) => source.trust === "pending")) return "source-pending";
  if (!candidates.length) return "partial";
  if (candidates.every((candidate) => candidate.verification.state === "verified-dual-rpc")) return "verified";
  if (candidates.every((candidate) => candidate.verification.state === "no-code" || candidate.verification.state === "rpc-disagreement")) return "rejected";
  return "partial";
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function absoluteDifference(left: string, right: string): bigint { const difference = BigInt(left) - BigInt(right); return difference < 0n ? -difference : difference; }
async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await worker(items[index]); }
  }));
  return output;
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}
function isNotFound(error: unknown): error is NodeJS.ErrnoException { return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"); }

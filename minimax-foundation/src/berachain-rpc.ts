const BERACHAIN_CHAIN_ID = "0x138de";

export class BerachainRpc {
  private chainVerified = false;
  constructor(private readonly url: string) {}

  /** Endpoint only; no credentials are emitted by any model-facing tool. */
  endpoint(): string { return this.url; }

  async chainHead(): Promise<{ chainId: string; blockNumber: string }> {
    const [chainId, blockNumber] = await Promise.all([this.call<string>("eth_chainId"), this.call<string>("eth_blockNumber")]);
    this.assertChainId(chainId);
    return { chainId, blockNumber };
  }

  async nativeBalance(address: string): Promise<{ address: string; wei: string; bera: string; block: string }> {
    assertAddress(address);
    const [head, wei] = await Promise.all([this.chainHead(), this.call<string>("eth_getBalance", [address, "latest"])]);
    const value = BigInt(wei);
    return { address, wei, bera: formatUnits(value, 18), block: head.blockNumber };
  }

  async nativeBalanceAt(address: string, block: string): Promise<{ address: string; wei: string; bera: string; block: string }> {
    assertAddress(address); assertBlock(block);
    await this.ensureChain();
    const wei = await this.call<string>("eth_getBalance", [address, block]);
    return { address, wei, bera: formatUnits(BigInt(wei), 18), block };
  }

  async transactionCount(address: string, block = "latest"): Promise<string> {
    assertAddress(address); assertBlock(block);
    await this.ensureChain();
    return this.call<string>("eth_getTransactionCount", [address, block]);
  }

  async gasPrice(): Promise<string> {
    await this.ensureChain();
    return this.call<string>("eth_gasPrice");
  }

  async recentBlocks(count: number): Promise<unknown[]> {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("count must be an integer from 1 to 20");
    const { blockNumber } = await this.chainHead();
    const head = BigInt(blockNumber);
    const blocks = await Promise.all(Array.from({ length: count }, (_, index) => this.call<Record<string, unknown>>("eth_getBlockByNumber", [toHex(head - BigInt(index)), true])));
    return blocks.map(compactBlock);
  }

  async block(blockNumber: string): Promise<unknown> {
    assertBlock(blockNumber);
    await this.ensureChain();
    return compactBlock(await this.call<Record<string, unknown>>("eth_getBlockByNumber", [blockNumber, true]));
  }

  async transaction(hash: string): Promise<unknown> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("txHash must be a 32-byte hexadecimal hash");
    await this.ensureChain();
    return this.call("eth_getTransactionByHash", [hash]);
  }

  /**
   * Bounded primary-chain event query. Public Berachain RPCs reject broad log
   * ranges, so callers must page explicitly rather than receiving silently
   * incomplete history.
   */
  async logs(input: { address: string; fromBlock: string; toBlock: string; topics?: Array<string | null> }): Promise<Array<{ address: string; blockNumber: string; transactionHash: string; logIndex: string; topics: string[]; data: string; removed: boolean }>> {
    assertAddress(input.address); assertBlock(input.fromBlock); assertBlock(input.toBlock);
    if (input.fromBlock === "latest" || input.toBlock === "latest") throw new Error("get_logs requires explicit hexadecimal fromBlock and toBlock for reproducible event evidence");
    const start = BigInt(input.fromBlock); const end = BigInt(input.toBlock);
    if (end < start) throw new Error("toBlock must not precede fromBlock");
    if (end - start > 4096n) throw new Error("get_logs range exceeds 4096 blocks; page the historical query explicitly");
    const topics = input.topics ?? [];
    if (topics.length > 4 || topics.some((topic) => topic !== null && !/^0x[0-9a-fA-F]{64}$/.test(topic))) throw new Error("topics must contain at most four null or 32-byte hexadecimal values");
    await this.ensureChain();
    const result = await this.call<Array<{ address: string; blockNumber: string; transactionHash: string; logIndex: string; topics: string[]; data: string; removed?: boolean }>>("eth_getLogs", [{ address: input.address, fromBlock: input.fromBlock, toBlock: input.toBlock, ...(topics.length ? { topics } : {}) }]);
    return result.map((log) => ({ address: log.address, blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.logIndex, topics: log.topics, data: log.data, removed: Boolean(log.removed) }));
  }

  /** Raw deployed bytecode, used only to verify a published contract address. */
  async code(address: string): Promise<string> {
    assertAddress(address);
    await this.ensureChain();
    const code = await this.call<string>("eth_getCode", [address, "latest"]);
    if (!/^0x[0-9a-fA-F]*$/.test(code)) throw new Error("eth_getCode returned non-hexadecimal bytecode");
    return code.toLowerCase();
  }

  async readContract(input: { to: string; data: string; from?: string; block?: string }): Promise<unknown> {
    assertAddress(input.to);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(input.data)) throw new Error("calldata must be hexadecimal bytes");
    if (input.from) assertAddress(input.from);
    const block = input.block ?? "latest";
    assertBlock(block);
    await this.ensureChain();
    return this.call("eth_call", [{ to: input.to, data: input.data, ...(input.from ? { from: input.from } : {}) }, block]);
  }

  async simulateTransaction(input: { from: string; to: string; data?: string; value?: string }): Promise<{ gas: unknown; result: unknown }> {
    assertAddress(input.from); assertAddress(input.to);
    const data = input.data ?? "0x";
    const value = input.value ?? "0x0";
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("transaction data/value must be hexadecimal");
    await this.ensureChain();
    const request = { from: input.from, to: input.to, data, value };
    const [gas, result] = await Promise.all([this.call("eth_estimateGas", [request]), this.call("eth_call", [request, "latest"])]);
    return { gas, result };
  }

  private async ensureChain(): Promise<void> {
    if (this.chainVerified) return;
    this.assertChainId(await this.call<string>("eth_chainId"));
    this.chainVerified = true;
  }

  private assertChainId(chainId: string): void {
    if (chainId.toLowerCase() !== BERACHAIN_CHAIN_ID) throw new Error(`RPC chain mismatch: expected ${BERACHAIN_CHAIN_ID}, received ${chainId}`);
  }

  private async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }) });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status} for ${method}`);
    const body = await response.json() as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`RPC ${method} failed (${body.error.code}): ${body.error.message}`);
    if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
    return body.result;
  }
}

function assertAddress(value: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("address must be a 20-byte hexadecimal address");
}
function assertBlock(value: string): void {
  if (value !== "latest" && !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error("block must be latest or a hexadecimal quantity");
}

function toHex(value: bigint): string { return `0x${value.toString(16)}`; }
function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Real block fields, normalized so an LLM receives actionable data rather than bloom filters and unbounded calldata. */
function compactBlock(block: Record<string, unknown>): Record<string, unknown> {
  const transactions = Array.isArray(block.transactions) ? block.transactions : [];
  return {
    number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp,
    miner: block.miner, gasLimit: block.gasLimit, gasUsed: block.gasUsed, baseFeePerGas: block.baseFeePerGas,
    transactionCount: transactions.length,
    transactions: transactions.slice(0, 25).map((transaction) => {
      if (typeof transaction === "string") return { hash: transaction };
      const item = transaction as Record<string, unknown>;
      return { hash: item.hash, from: item.from, to: item.to, value: item.value, type: item.type, inputSelector: typeof item.input === "string" ? item.input.slice(0, 10) : undefined };
    }),
    transactionsTruncated: transactions.length > 25
  };
}

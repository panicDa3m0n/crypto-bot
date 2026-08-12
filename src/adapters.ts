import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { erc20Abi, type BerachainClients } from "./chain.js";

const wberaAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function balanceOf(address) view returns (uint256)"
]);
const erc4626Abi = parseAbi([
  "function asset() view returns (address)",
  "function maxDeposit(address) view returns (uint256)",
  "function previewDeposit(uint256) view returns (uint256)",
  "function maxWithdraw(address) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)"
]);
const rewardVaultAbi = parseAbi([
  "function stakeToken() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function stake(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function getReward(address account, address recipient) returns (uint256)"
]);

export type ProposedCall = {
  protocolId: string;
  to: Address;
  data: Hex;
  value: bigint;
  preflight: { gas: bigint; gasPriceWei: bigint; blockNumber: bigint };
  deadline: Date;
  maxSlippageBps: number;
  approval?: { token: Address; spender: Address; amount: bigint; spenderCodeHash?: Hex };
};

/** Produces only exact ERC-20 approvals; it never creates an unlimited allowance. */
export class ExactAllowanceAdapter {
  constructor(private readonly chain: BerachainClients) {}

  async prepareIfNeeded(token: Address, owner: Address, spender: Address, amount: bigint, spenderCodeHash?: Hex): Promise<ProposedCall | undefined> {
    if (amount <= 0n) throw new Error("approval amount must be positive");
    const current = await this.chain.primary.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
    if (current >= amount) return undefined;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    const preflight = await this.chain.preflight({ to: token, data, value: 0n, account: owner });
    return {
      protocolId: `approval:${token.toLowerCase()}:${spender.toLowerCase()}`,
      to: token, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps: 1,
      approval: { token, spender, amount, spenderCodeHash }
    };
  }
}

export class WberaAdapter {
  readonly address = "0x6969696969696969696969696969696969696969" as Address;
  constructor(private readonly chain: BerachainClients) {}

  async prepareWrap(amountWei: bigint, maxSlippageBps = 1): Promise<ProposedCall> {
    if (amountWei <= 0n) throw new Error("wrap amount must be positive");
    const data = encodeFunctionData({ abi: wberaAbi, functionName: "deposit" });
    const preflight = await this.chain.preflight({ to: this.address, data, value: amountWei });
    return { protocolId: "wbera-wrap", to: this.address, data, value: amountWei, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps };
  }

  async prepareUnwrap(amountWei: bigint, maxSlippageBps = 1): Promise<ProposedCall> {
    if (amountWei <= 0n) throw new Error("unwrap amount must be positive");
    const data = encodeFunctionData({ abi: wberaAbi, functionName: "withdraw", args: [amountWei] });
    const preflight = await this.chain.preflight({ to: this.address, data, value: 0n });
    return { protocolId: "wbera-unwrap", to: this.address, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps };
  }
}

export class Erc4626Adapter {
  constructor(private readonly chain: BerachainClients, readonly vault: Address) {}

  async inspect(owner: Address) {
    const [asset, maxDeposit, maxWithdraw] = await Promise.all([
      this.chain.primary.readContract({ address: this.vault, abi: erc4626Abi, functionName: "asset" }),
      this.chain.primary.readContract({ address: this.vault, abi: erc4626Abi, functionName: "maxDeposit", args: [owner] }),
      this.chain.primary.readContract({ address: this.vault, abi: erc4626Abi, functionName: "maxWithdraw", args: [owner] })
    ]);
    return { asset, maxDeposit, maxWithdraw };
  }

  async prepareDeposit(assets: bigint, receiver: Address, maxSlippageBps = 50): Promise<ProposedCall & { previewShares: bigint }> {
    const previewShares = await this.chain.primary.readContract({ address: this.vault, abi: erc4626Abi, functionName: "previewDeposit", args: [assets] });
    const data = encodeFunctionData({ abi: erc4626Abi, functionName: "deposit", args: [assets, receiver] });
    const preflight = await this.chain.preflight({ to: this.vault, data, value: 0n });
    return { protocolId: `erc4626:${this.vault.toLowerCase()}`, to: this.vault, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps, previewShares };
  }

  async prepareWithdraw(assets: bigint, receiver: Address, owner: Address, maxSlippageBps = 50): Promise<ProposedCall> {
    const data = encodeFunctionData({ abi: erc4626Abi, functionName: "withdraw", args: [assets, receiver, owner] });
    const preflight = await this.chain.preflight({ to: this.vault, data, value: 0n });
    return { protocolId: `erc4626:${this.vault.toLowerCase()}`, to: this.vault, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps };
  }
}

export class RewardVaultAdapter {
  constructor(private readonly chain: BerachainClients, readonly vault: Address) {}

  async inspect(account: Address) {
    const [stakeToken, staked] = await Promise.all([
      this.chain.primary.readContract({ address: this.vault, abi: rewardVaultAbi, functionName: "stakeToken" }),
      this.chain.primary.readContract({ address: this.vault, abi: rewardVaultAbi, functionName: "balanceOf", args: [account] })
    ]);
    return { stakeToken, staked };
  }

  async prepareStake(amount: bigint, maxSlippageBps = 50): Promise<ProposedCall> {
    const data = encodeFunctionData({ abi: rewardVaultAbi, functionName: "stake", args: [amount] });
    const preflight = await this.chain.preflight({ to: this.vault, data, value: 0n });
    return { protocolId: `reward-vault:${this.vault.toLowerCase()}`, to: this.vault, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps };
  }

  async prepareWithdraw(amount: bigint, maxSlippageBps = 50): Promise<ProposedCall> {
    const data = encodeFunctionData({ abi: rewardVaultAbi, functionName: "withdraw", args: [amount] });
    const preflight = await this.chain.preflight({ to: this.vault, data, value: 0n });
    return { protocolId: `reward-vault:${this.vault.toLowerCase()}`, to: this.vault, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps };
  }

  async prepareClaim(account: Address, recipient: Address): Promise<ProposedCall> {
    const data = encodeFunctionData({ abi: rewardVaultAbi, functionName: "getReward", args: [account, recipient] });
    const preflight = await this.chain.preflight({ to: this.vault, data, value: 0n });
    return { protocolId: `reward-vault:${this.vault.toLowerCase()}`, to: this.vault, data, value: 0n, preflight, deadline: new Date(Date.now() + 60_000), maxSlippageBps: 1 };
  }
}

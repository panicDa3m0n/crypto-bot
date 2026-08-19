// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMorpho { function flashLoan(address token, uint256 assets, bytes calldata data) external; }
interface IBalancerVault {
    function flashLoan(address recipient, address[] calldata tokens, uint256[] calldata amounts, bytes calldata userData) external;
}
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice The Liquidity-Graph EXECUTOR. Owner-only, zero-custody atomic strategy engine: runs an arbitrary
/// batch of calls in ONE transaction — optionally funded by a 0-fee flash loan — and REVERTS unless it ends
/// with at least `minProfit` more of the loan/profit asset. The call batch is type-agnostic (any swap/
/// lend/stake/wrap/claim is just a Call), so new opportunity types need no contract change: the KG builds
/// the calls off-chain, the require(minProfit) is the ONLY on-chain safety boundary. Multi-provider by
/// design — Morpho is active (0-fee); Balancer V2 + Aave are seams (fill a callback, no rewrite). Robust
/// pre-approval (approveMax) so a swap never blocks on a missing allowance. Holds no funds between txs.
contract KGExecutor {
    address public immutable owner;
    address public immutable morpho;   // provider: Morpho Blue (0-fee)
    address public immutable balancer; // provider: Balancer V2 Vault (0-fee) — seam; may be zero if unused
    bool private _entered;

    struct Call { address target; uint256 value; bytes data; }
    enum Provider { Morpho, Balancer }

    constructor(address _morpho, address _balancer) { owner = msg.sender; morpho = _morpho; balancer = _balancer; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    /// Robust pre-approval: MAX-approve each token→spender once. Idempotent; ensures no swap ever fails on
    /// a missing allowance. Owner-driven (the KG pre-approves the routers/protocols a cycle will touch).
    function approveMax(address[] calldata tokens, address[] calldata spenders) external onlyOwner {
        require(tokens.length == spenders.length, "len");
        for (uint256 i = 0; i < tokens.length; i++) IERC20(tokens[i]).approve(spenders[i], type(uint256).max);
    }

    /// Flash-loan `amount` of `loanToken` from provider `p`, run `calls`, repay, keep >= `minProfit`.
    function flashExecute(Provider p, address loanToken, uint256 amount, uint256 minProfit, Call[] calldata calls) external onlyOwner {
        _entered = true;
        bytes memory data = abi.encode(loanToken, amount, minProfit, calls);
        if (p == Provider.Morpho) {
            IMorpho(morpho).flashLoan(loanToken, amount, data);
        } else {
            address[] memory t = new address[](1); t[0] = loanToken;
            uint256[] memory a = new uint256[](1); a[0] = amount;
            IBalancerVault(balancer).flashLoan(address(this), t, a, data);
        }
        _entered = false;
    }

    /// Morpho callback — repay by approving Morpho to pull the loan back (0 fee).
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        require(msg.sender == morpho && _entered, "unauthorized");
        (address loanToken, uint256 amount, uint256 minProfit, Call[] memory calls) = abi.decode(data, (address, uint256, uint256, Call[]));
        _runAndCheck(loanToken, amount, 0, minProfit, calls);
        IERC20(loanToken).approve(morpho, assets);
    }

    /// Balancer V2 callback — repay by transferring amount+fee back to the Vault.
    function receiveFlashLoan(address[] calldata tokens, uint256[] calldata amounts, uint256[] calldata feeAmounts, bytes calldata data) external {
        require(msg.sender == balancer && _entered, "unauthorized");
        (address loanToken, uint256 amount, uint256 minProfit, Call[] memory calls) = abi.decode(data, (address, uint256, uint256, Call[]));
        _runAndCheck(loanToken, amount, feeAmounts[0], minProfit, calls);
        IERC20(tokens[0]).transfer(balancer, amounts[0] + feeAmounts[0]);
    }

    function _runAndCheck(address loanToken, uint256 amount, uint256 fee, uint256 minProfit, Call[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            require(ok, "call failed");
        }
        require(IERC20(loanToken).balanceOf(address(this)) >= amount + fee + minProfit, "profit below min");
    }

    /// Run `calls` atomically with the owner's own funds, guarded on `profitToken`.
    function execute(address profitToken, uint256 minProfit, Call[] calldata calls) external onlyOwner {
        uint256 startBal = IERC20(profitToken).balanceOf(address(this));
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            require(ok, "call failed");
        }
        require(IERC20(profitToken).balanceOf(address(this)) >= startBal + minProfit, "profit below min");
    }

    /// Owner sweeps any leftover token (native with token = address(0)).
    function sweep(address token) external onlyOwner {
        if (token == address(0)) { (bool ok, ) = owner.call{value: address(this).balance}(""); require(ok, "sweep"); }
        else { IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this))); }
    }
    receive() external payable {}
}

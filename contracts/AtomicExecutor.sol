// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IMorpho { function flashLoan(address token, uint256 assets, bytes calldata data) external; }
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Owner-only, zero-custody atomic strategy engine. Runs an arbitrary batch
/// of calls inside one transaction (optionally funded by a Morpho 0%-fee flash loan)
/// and reverts unless it ends with at least `minProfit` more of the target asset.
/// It holds no funds between transactions; only the owner can drive it.
contract AtomicExecutor {
    address public immutable owner;
    address public immutable morpho;
    bool private _entered;

    struct Call { address target; uint256 value; bytes data; }

    constructor(address _morpho) { owner = msg.sender; morpho = _morpho; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    /// Flash-loan `amount` of `loanToken`, run `calls`, repay, keep >= `minProfit` for the owner.
    function flashExecute(address loanToken, uint256 amount, uint256 minProfit, Call[] calldata calls) external onlyOwner {
        _entered = true;
        IMorpho(morpho).flashLoan(loanToken, amount, abi.encode(loanToken, amount, minProfit, calls));
        _entered = false;
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        require(msg.sender == morpho && _entered, "unauthorized");
        (address loanToken, uint256 amount, uint256 minProfit, Call[] memory calls) = abi.decode(data, (address, uint256, uint256, Call[]));
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, ) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            require(ok, "call failed");
        }
        uint256 endBal = IERC20(loanToken).balanceOf(address(this));
        require(endBal >= amount + minProfit, "profit below min");
        IERC20(loanToken).approve(morpho, assets); // let Morpho pull the loan back
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

    /// Owner sweeps any leftover token (or native with token = address(0)).
    function sweep(address token) external onlyOwner {
        if (token == address(0)) { (bool ok, ) = owner.call{value: address(this).balance}(""); require(ok, "sweep"); }
        else { IERC20(token).transfer(owner, IERC20(token).balanceOf(address(this))); }
    }
    receive() external payable {}
}

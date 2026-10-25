// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IUniswapV2Factory} from "./interfaces/IUniswapV2.sol";

/// @title LaunchToken
/// @notice Fixed-supply ERC-20 created by ApeLaunchpad. No owner, no mint, no tax, no blacklist.
/// @dev One rule until the token graduates: nobody can send tokens to its Uniswap V2 pair, so the pool
///      can't be seeded at a fake price before the launchpad adds the real liquidity. The pair is created
///      in the constructor, so it can't exist before the token does.
contract LaunchToken is ERC20, ERC20Burnable {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    address public immutable launchpad;
    address public immutable pair;
    string public metadataURI;
    bool public tradingOpen;

    error NotLaunchpad();
    error PoolNotOpen();

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        address v2Factory,
        address weth
    ) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        metadataURI = metadataURI_;
        pair = IUniswapV2Factory(v2Factory).createPair(address(this), weth);
        _mint(msg.sender, TOTAL_SUPPLY);
    }

    /// @notice Called once by the launchpad when the bonding curve sells out. Cannot be undone.
    function openTrading() external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        tradingOpen = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == pair && !tradingOpen) revert PoolNotOpen();
        super._update(from, to, value);
    }
}

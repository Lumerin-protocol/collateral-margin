// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal GOV stand-in for redeemer tests: 6 decimals, freely mintable.
contract GovTokenMock is ERC20 {
    constructor() ERC20("Titan Governance", "GOV") {
        _mint(msg.sender, 50_000_000 * 10 ** 6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

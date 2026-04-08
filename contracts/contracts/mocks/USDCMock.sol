//SPDX-License-Identifier: MIT
pragma solidity >0.8.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract USDCMock is ERC20, ERC20Permit {
    uint8 private constant DECIMALS = 6;

    constructor() ERC20("USDC Titan", "USDC") ERC20Permit("USDC Titan") {
        _mint(msg.sender, 1_000_000 * 10 ** DECIMALS);
    }

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }
}

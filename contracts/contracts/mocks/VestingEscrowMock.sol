// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Records `lockFor` calls so redeemer tests can assert the escrowed half of a
///         payout, mirroring the real `VestingEscrow.lockFor` interface.
contract VestingEscrowMock {
    mapping(address => uint256) public lockedOf;
    uint256 public totalLocked;

    event Locked(address indexed user, uint256 amount);

    function lockFor(address user, uint256 amount) external {
        lockedOf[user] += amount;
        totalLocked += amount;
        emit Locked(user, amount);
    }
}

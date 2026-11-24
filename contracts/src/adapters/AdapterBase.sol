// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Restricts `swap` to one bound vault, so nobody can sweep tokens that sit in the adapter.
abstract contract AdapterBase {
    error NotVault();
    error AlreadyBound();
    error NotDeployer();

    address public immutable deployer;
    address public vault;

    event VaultBound(address indexed vault);

    constructor() {
        deployer = msg.sender;
    }

    /// @notice One-time binding of the vault that may call `swap`.
    function bindVault(address vault_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (vault != address(0)) revert AlreadyBound();
        vault = vault_;
        emit VaultBound(vault_);
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interface/ISystemSettings.sol";

contract MMLPToken is ERC20Upgradeable, OwnableUpgradeable {
    ISystemSettings public systemSettings;

    constructor(
        string memory _name,
        string memory _symbol,
        address _systemSettings
    ) public {
        systemSettings = ISystemSettings(_systemSettings);
        __ERC20_init(_name, _symbol);
        __Ownable_init();
    }

    function mint(address _account, uint256 _amount) external onlyOwner {
        _mint(_account, _amount);
    }

    function burn(address _account, uint256 _amount) external onlyOwner {
        _burn(_account, _amount);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override {
        amount;
        require(systemSettings.checkTransfer(from, to), "illegal transfer");
    }
}

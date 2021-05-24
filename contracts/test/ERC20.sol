// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// providing optional methods (name, symbol and decimals)
contract ERC20Token is ERC20 {
    address private _owner;

    modifier onlyOwner() {
        require(_owner == msg.sender, "Ownable: caller is not the owner");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        uint256 _initialSupply
    ) public ERC20(_name, _symbol) {
        _owner = msg.sender;
        _mint(msg.sender, _initialSupply);
    }

    function setupDecimals(uint8 decimals_) external {
        _setupDecimals(decimals_);
    }

    function mint(address _account, uint256 _amount) external onlyOwner {
        _mint(_account, _amount);
    }
}

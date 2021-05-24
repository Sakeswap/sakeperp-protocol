// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;

contract PriceFeedMock {
    uint256 public price;
    uint256 public twapPrice;

    constructor(uint256 _price, uint256 _twapPrice) public {
        price = _price;
        twapPrice = _twapPrice;
    }

    function getPrice(bytes32) public view returns (uint256) {
        return price;
    }

    function setPrice(uint256 _price) public {
        price = _price;
    }

    function getTwapPrice(bytes32, uint256) public view returns (uint256) {
        return twapPrice;
    }

    function setTwapPrice(uint256 _twapPrice) public {
        twapPrice = _twapPrice;
    }
}
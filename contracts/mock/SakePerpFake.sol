// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "../SakePerp.sol";
import "../interface/IExchange.sol";

// temporary commented unused functions to bypass contract too large error
contract SakePerpFake is SakePerp {
    uint256 private timestamp = 1444004400;
    uint256 private number = 10001;

    function mock_setBlockTimestamp(uint256 _timestamp) public {
        timestamp = _timestamp;
    }

    function mock_setBlockNumber(uint256 _number) public {
        number = _number;
    }

    function mock_getCurrentTimestamp() public view returns (uint256) {
        return _blockTimestamp();
    }

    function mock_getCurrentBlockNumber() public view returns (uint256) {
        return _blockNumber();
    }

    // // Override BlockContext here
    function _blockTimestamp() internal view override returns (uint256) {
        return timestamp;
    }

    function _blockNumber() internal view override returns (uint256) {
        return number;
    }

    function mockSetRestrictionMode(IExchange _amm) external {
        enterRestrictionMode(_amm);
    }

    function isInRestrictMode(address _amm, uint256 _block) external view returns (bool) {
        return exchangeMap[_amm].lastRestrictionBlock == _block;
    }
}

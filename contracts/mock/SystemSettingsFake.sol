// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "../SystemSettings.sol";
import "../interface/IExchange.sol";

// temporary commented unused functions to bypass contract too large error
contract SystemSettingsFake is SystemSettings {
    uint256 private timestamp = 1444004400;
    uint256 private number = 10001;

    function mock_setBlockTimestamp(uint256 _timestamp) public {
        timestamp = _timestamp;
    }

    function mock_getCurrentTimestamp() public view returns (uint256) {
        return _blockTimestamp();
    }

    function _blockTimestamp() internal override view virtual returns (uint256) {
        return timestamp;
    }
}

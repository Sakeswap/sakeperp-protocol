// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

contract Receiver {
    function say() public pure returns (string memory) {
        return "i am a test contract";
    }
}

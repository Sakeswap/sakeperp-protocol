// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

interface ISakePerpVaultTypes {
    /**
     * @notice pool types
     * @param HIGH high risk pool
     * @param LOW low risk pool
     */
    enum Risk {HIGH, LOW}
}

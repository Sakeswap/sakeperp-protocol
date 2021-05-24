// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { Decimal } from "../utils/Decimal.sol";

interface IBaseBridge {
    function erc20Transfer(
        IERC20Upgradeable _token,
        address _receiver,
        Decimal.decimal calldata _amount
    ) external;
}

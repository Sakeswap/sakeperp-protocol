// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../utils/Decimal.sol";
import "./IExchange.sol";

interface IInsuranceFund {
    function withdraw(Decimal.decimal calldata _amount) external returns (Decimal.decimal memory badDebt);

    function setExchange(IExchange _exchange) external;

    function setBeneficiary(address _beneficiary) external;
}

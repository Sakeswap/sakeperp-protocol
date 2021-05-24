// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../utils/Decimal.sol";
import "../utils/SignedDecimal.sol";
import "../interface/ISakePerp.sol";
import "../interface/IExchange.sol";
import "../types/ISakePerpVaultTypes.sol";

contract SakePerpVaultMock {
    mapping(address => SignedDecimal.signedDecimal) public availableLiquidity;
    mapping(address => Decimal.decimal) public cachedLiquidity;

    function setTotalMMAvailableLiquidity(address _exchange, SignedDecimal.signedDecimal memory _liquidity) public {
        availableLiquidity[_exchange] = _liquidity;
    }

    function setTotalMMCachedLiquidity(address _exchange, Decimal.decimal memory _liquidity) public {
        cachedLiquidity[_exchange] = _liquidity;
    }

    function getTotalMMAvailableLiquidity(address _exchange) public view returns (SignedDecimal.signedDecimal memory) {
        return availableLiquidity[_exchange];
    }

    function getTotalMMCachedLiquidity(address _exchange) public view returns (Decimal.decimal memory) {
        return cachedLiquidity[_exchange];
    }

    function modifyLiquidity() pure external {
        return;
    }

    function setRiskLiquidityWeight(address _exchange, uint256 _highWeight, uint256 _lowWeight) public pure {
        _exchange;
        _highWeight;
        _lowWeight;
        return;
    }

    function setMaxLoss(
        address _exchange,
        ISakePerpVaultTypes.Risk _risk,
        uint256 _max
    ) public pure {
        _exchange;
        _risk;
        _max;
    }
}

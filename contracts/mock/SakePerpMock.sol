// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../utils/Decimal.sol";
import "../utils/SignedDecimal.sol";
import "../interface/ISakePerp.sol";
import "../interface/IExchange.sol";

contract SakePerpMock {
    mapping(address => SignedDecimal.signedDecimal) liquidity;
    IExchange public exchange;

    function getMMLiquidity(address _exchange) external view returns (SignedDecimal.signedDecimal memory) {
        return liquidity[_exchange];
    }

    function setMMLiquidity(address _exchange, SignedDecimal.signedDecimal memory _liquidity) public {
        liquidity[_exchange] = _liquidity;
    }

    function settleFunding() public {
        exchange.settleFunding();
    }

    function setExchange(IExchange _exchange) public {
        exchange = _exchange;
    }

    function swapInput(
        IExchange.Dir _dir,
        Decimal.decimal calldata _quoteAssetAmount,
        Decimal.decimal calldata _baseAssetAmountLimit
    ) public {
        exchange.swapInput(_dir, _quoteAssetAmount, _baseAssetAmountLimit);
    }

    function swapOutput(
        IExchange.Dir _dir,
        Decimal.decimal calldata _baseAssetAmount,
        Decimal.decimal calldata _quoteAssetAmountLimit,
        bool _skipFluctuationCheck
    ) public {
        exchange.swapOutput(_dir, _baseAssetAmount, _quoteAssetAmountLimit, _skipFluctuationCheck);
    }

    function getLatestCumulativePremiumFraction(IExchange _exchange) public pure returns (SignedDecimal.signedDecimal memory) {
        _exchange;
        return SignedDecimal.zero();
    }

    function getLatestCumulativeOvernightFeeRate(IExchange _exchange) public pure returns (Decimal.decimal memory) {
        _exchange;
        return Decimal.zero();
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../types/ISakePerpTypes.sol";
import "./IExchange.sol";

interface ISakePerpState {
    struct TradingState {
        uint256 lastestLongTime;
        uint256 lastestShortTime;
    }

    struct RemainMarginInfo {
        Decimal.decimal remainMargin;
        Decimal.decimal badDebt;
        SignedDecimal.signedDecimal fundingPayment;
        Decimal.decimal overnightFee;
    }

    function checkWaitingPeriod(
        address _exchange,
        address _trader,
        ISakePerpTypes.Side _side
    ) external returns (bool);

    function updateOpenInterestNotional(IExchange _exchange, SignedDecimal.signedDecimal memory _amount) external;

    function getWhiteList() external view returns (address);

    function getPositionNotionalAndUnrealizedPnl(
        IExchange _exchange,
        ISakePerpTypes.Position memory _position,
        ISakePerpTypes.PnlCalcOption _pnlCalcOption
    ) external view returns (Decimal.decimal memory positionNotional, SignedDecimal.signedDecimal memory unrealizedPnl);

    function calcPositionAfterLiquidityMigration(
        IExchange _exchange,
        ISakePerpTypes.Position memory _position,
        uint256 _latestLiquidityIndex
    ) external view returns (ISakePerpTypes.Position memory);

    function calcPositionAfterLiquidityMigrationWithoutNew(
        IExchange _exchange,
        ISakePerpTypes.Position memory _position,
        uint256 _latestLiquidityIndex
    ) external returns (SignedDecimal.signedDecimal memory);

    function calcRemainMarginWithFundingPaymentAndOvernightFee(
        IExchange _exchange,
        ISakePerpTypes.Position memory _oldPosition,
        SignedDecimal.signedDecimal memory _marginDelta
    ) external view returns (RemainMarginInfo memory remainMarginInfo);
}

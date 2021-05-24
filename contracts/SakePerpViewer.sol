// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/Decimal.sol";
import "./utils/SignedDecimal.sol";
import "./utils/MixedDecimal.sol";
import "./interface/IExchange.sol";
import "./interface/ISystemSettings.sol";
import "./interface/ISakePerp.sol";

contract SakePerpViewer is OwnableUpgradeable {
    using Decimal for Decimal.decimal;
    using SignedDecimal for SignedDecimal.signedDecimal;
    using MixedDecimal for SignedDecimal.signedDecimal;
    using SafeMathUpgradeable for uint256;

    ISakePerp public sakePerp;
    ISystemSettings public systemSettings;

    function initialize(ISakePerp _sakePerp, ISystemSettings _systemSettings) public initializer {
        sakePerp = _sakePerp;
        systemSettings = _systemSettings;
    }

    /**
     * @notice get unrealized PnL
     * @param _exchange IExchange address
     * @param _trader trader address
     * @param _pnlCalcOption ClearingHouse.PnlCalcOption, can be SPOT_PRICE or TWAP.
     * @return unrealized PnL in 18 digits
     */
    function getUnrealizedPnl(
        IExchange _exchange,
        address _trader,
        ISakePerp.PnlCalcOption _pnlCalcOption
    ) external view returns (SignedDecimal.signedDecimal memory) {
        (, SignedDecimal.signedDecimal memory unrealizedPnl) =
            (sakePerp.getPositionNotionalAndUnrealizedPnl(_exchange, _trader, _pnlCalcOption));
        return unrealizedPnl;
    }

    /**
     * @notice get personal balance with funding payment
     * @param _quoteToken ERC20 token address
     * @param _trader trader address
     * @return margin personal balance with funding payment in 18 digits
     */
    function getPersonalBalanceWithFundingPayment(IERC20Upgradeable _quoteToken, address _trader)
        external
        view
        returns (Decimal.decimal memory margin)
    {
        IExchange[] memory exchanges = systemSettings.getAllExchanges();
        for (uint256 i = 0; i < exchanges.length; i++) {
            if (IExchange(exchanges[i]).quoteAsset() != _quoteToken) {
                continue;
            }
            Decimal.decimal memory posMargin = getPersonalPositionWithFundingPayment(exchanges[i], _trader).margin;
            margin = margin.addD(posMargin);
        }
    }

    /**
     * @notice get personal position with funding payment
     * @param _exchange IExchange address
     * @param _trader trader address
     * @return position SakePerp.Position struct
     */
    function getPersonalPositionWithFundingPayment(IExchange _exchange, address _trader)
        public
        view
        returns (ISakePerp.Position memory position)
    {
        position = sakePerp.getPosition(_exchange, _trader);
        SignedDecimal.signedDecimal memory marginWithFundingPayment =
            MixedDecimal
                .fromDecimal(position.margin)
                .addD(getFundingPayment(position, sakePerp.getLatestCumulativePremiumFraction(_exchange)))
                .subD(getOvernightFee(position, sakePerp.getLatestCumulativeOvernightFeeRate(_exchange)));
        position.margin = marginWithFundingPayment.toInt() >= 0 ? marginWithFundingPayment.abs() : Decimal.zero();
    }

    /**
     * @notice verify if trader's position needs to be migrated
     * @param _exchange IAmm address
     * @param _trader trader address
     * @return true if trader's position is not at the latest Amm curve, otherwise is false
     */
    function isPositionNeedToBeMigrated(IExchange _exchange, address _trader) external view returns (bool) {
        ISakePerp.Position memory unadjustedPosition = sakePerp.getUnadjustedPosition(_exchange, _trader);
        if (unadjustedPosition.size.toInt() == 0) {
            return false;
        }

        uint256 latestLiquidityIndex = _exchange.getLiquidityHistoryLength().sub(1);
        if (unadjustedPosition.liquidityHistoryIndex == latestLiquidityIndex) {
            return false;
        }
        return true;
    }

    /**
     * @notice get personal margin ratio
     * @param _exchange IExchange address
     * @param _trader trader address
     * @return personal margin ratio in 18 digits
     */
    function getMarginRatio(IExchange _exchange, address _trader)
        external
        view
        returns (SignedDecimal.signedDecimal memory)
    {
        return sakePerp.getMarginRatio(_exchange, _trader);
    }

    function getMarginRatios(IExchange _exchange, address[] memory _traders)
        external
        view
        returns (SignedDecimal.signedDecimal[] memory)
    {
        SignedDecimal.signedDecimal[] memory ratios = new SignedDecimal.signedDecimal[](_traders.length);
        for (uint256 i = 0; i < _traders.length; i++) {
            ISakePerp.Position memory position = sakePerp.getPosition(_exchange, _traders[i]);
            if (position.size.toInt() == 0 || position.openNotional.toUint() == 0) {
                ratios[i] = SignedDecimal.zero();
            } else {
                ratios[i] = sakePerp.getMarginRatio(_exchange, _traders[i]);
            }
        }
        return ratios;
    }

    // negative means trader paid and vice versa
    function getFundingPayment(
        ISakePerp.Position memory _position,
        SignedDecimal.signedDecimal memory _latestCumulativePremiumFraction
    ) private pure returns (SignedDecimal.signedDecimal memory) {
        return
            _position.size.toInt() == 0
                ? SignedDecimal.zero()
                : _latestCumulativePremiumFraction
                    .subD(_position.lastUpdatedCumulativePremiumFraction)
                    .mulD(_position.size)
                    .mulScalar(-1);
    }

    function getOvernightFee(ISakePerp.Position memory _position, Decimal.decimal memory _latestCumulativeOvernightFee)
        private
        pure
        returns (Decimal.decimal memory)
    {
        return
            _position.size.toInt() == 0
                ? Decimal.zero()
                : _latestCumulativeOvernightFee.subD(_position.lastUpdatedCumulativeOvernightFeeRate).mulD(
                    _position.openNotional
                );
    }

    /**
     * @notice get personal current funding payment and overnight fee
     * @param _exchange IExchange address
     * @param _trader trader address
     */
    function getFundingAndOvernightFee(IExchange _exchange, address _trader)
        external
        view
        returns (SignedDecimal.signedDecimal memory fundingPayment, Decimal.decimal memory overnightFee)
    {
        ISakePerp.Position memory position = sakePerp.getPosition(_exchange, _trader);
        SignedDecimal.signedDecimal memory latestCumulativePremiumFraction =
            sakePerp.getLatestCumulativePremiumFraction(_exchange);
        Decimal.decimal memory latestCumulativeOvernightFee = sakePerp.getLatestCumulativeOvernightFeeRate(_exchange);
        fundingPayment = getFundingPayment(position, latestCumulativePremiumFraction);
        overnightFee = getOvernightFee(position, latestCumulativeOvernightFee);
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interface/ISakePerpState.sol";
import "./interface/ISakePerp.sol";
import "./interface/IExchange.sol";
import "./utils/BlockContext.sol";
import "./utils/Decimal.sol";
import "./utils/SignedDecimal.sol";
import "./utils/MixedDecimal.sol";
import "./types/ISakePerpTypes.sol";
import "./types/IExchangeTypes.sol";

contract SakePerpState is ISakePerpState, OwnableUpgradeable, BlockContext {
    using SafeMathUpgradeable for uint256;
    using Decimal for Decimal.decimal;
    using SignedDecimal for SignedDecimal.signedDecimal;
    using MixedDecimal for SignedDecimal.signedDecimal;

    mapping(address => mapping(address => TradingState)) public tradingState;
    address public SakePerp;
    uint256 public waitingPeriodSecs;

    // key by amm address. will be deprecated or replaced after guarded period.
    // it's not an accurate open interest, just a rough way to control the unexpected loss at the beginning
    mapping(address => Decimal.decimal) public openInterestNotionalMap;
    mapping(uint256 => SignedDecimal.signedDecimal) public snapshotDeltaPosNotional;

    // designed for arbitragers who can hold unlimited positions. will be removed after guarded period
    address internal whitelist;

    //**********************************************************//
    //    Can not change the order of above state variables     //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    // address don't need to wait to open reverse position
    mapping(address => bool) public waitingWhitelist;
    address[] internal allWaitingWhitelist;

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    modifier onlySakePerp() {
        require(SakePerp == _msgSender(), "caller is not SakePerp");
        _;
    }

    function initialize(address _SakePerp, uint256 _waitingPeriodSecs) public initializer {
        __Ownable_init();

        SakePerp = _SakePerp;
        waitingPeriodSecs = _waitingPeriodSecs;
    }

    /**
     * @notice trader can't do the reverse operation during waiting period
     */
    function checkWaitingPeriod(
        address _exchange,
        address _trader,
        ISakePerpTypes.Side _side
    ) public override onlySakePerp returns (bool) {
        if (waitingWhitelist[_trader]) return true;
        if (_side == ISakePerpTypes.Side.BUY) {
            uint256 lastestShortTime = tradingState[_exchange][_trader].lastestShortTime;
            if (lastestShortTime.add(waitingPeriodSecs) > _blockTimestamp()) {
                return false;
            }
            tradingState[_exchange][_trader].lastestLongTime = _blockTimestamp();
        } else {
            uint256 lastestLongTime = tradingState[_exchange][_trader].lastestLongTime;
            if (lastestLongTime.add(waitingPeriodSecs) > _blockTimestamp()) {
                return false;
            }
            tradingState[_exchange][_trader].lastestShortTime = _blockTimestamp();
        }
        return true;
    }

    /**
     * @notice set max waiting period
     * @dev only owner can call
     * @param _waitingPeriodSecs new max waiting period in seconds
     */
    function setWaitingPeriodSecs(uint256 _waitingPeriodSecs) public onlyOwner {
        waitingPeriodSecs = _waitingPeriodSecs;
    }

    /**
     * @notice add an address in the whitelist. People in the whitelist can hold unlimited positions.
     * @dev only owner can call
     * @param _whitelist an address
     */
    function setWhitelist(address _whitelist) public onlyOwner {
        whitelist = _whitelist;
    }

    function getWhiteList() public view override returns (address) {
        return whitelist;
    }

    function setWaitingWhitelist(address _trader, bool _add) public onlyOwner {
        bool _added = waitingWhitelist[_trader];
        require(_added != _add, "state is the same");
        waitingWhitelist[_trader] = _add;
        if (_add) {
            allWaitingWhitelist.push(_trader);
        } else {
            uint256 listLength = allWaitingWhitelist.length;
            for (uint256 i = 0; i < listLength; i++) {
                if (allWaitingWhitelist[i] == _trader) {
                    allWaitingWhitelist[i] = allWaitingWhitelist[listLength - 1];
                    allWaitingWhitelist.pop();
                    break;
                }
            }
        }
    }

    function getAllWaitingWhitelist() public view returns (address[] memory) {
        return allWaitingWhitelist;
    }

    /**
     * @dev assume this will be removes soon once the guarded period has ended. caller need to ensure amm exist
     */
    function updateOpenInterestNotional(IExchange _exchange, SignedDecimal.signedDecimal memory _amount)
        public
        override
        onlySakePerp
    {
        // when cap = 0 means no cap
        uint256 cap = _exchange.getOpenInterestNotionalCap().toUint();
        address ammAddr = address(_exchange);
        if (cap > 0) {
            SignedDecimal.signedDecimal memory updatedOpenInterestNotional =
                _amount.addD(openInterestNotionalMap[ammAddr]);
            // the reduced open interest can be larger than total when profit is too high and other position are bankrupt
            if (updatedOpenInterestNotional.toInt() < 0) {
                updatedOpenInterestNotional = SignedDecimal.zero();
            }
            if (_amount.toInt() > 0) {
                // whitelist won't be restrict by open interest cap
                require(updatedOpenInterestNotional.toUint() <= cap || msg.sender == whitelist, "over limit");
            }
            openInterestNotionalMap[ammAddr] = updatedOpenInterestNotional.abs();
        }
    }

    /**
     * @notice get position notional and unrealized Pnl without fee expense and funding payment
     * @param _exchange IExchange address
     * @param _position trader position
     * @param _pnlCalcOption enum PnlCalcOption, SPOT_PRICE for spot price and TWAP for twap price
     * @return positionNotional position notional
     * @return unrealizedPnl unrealized Pnl
     */
    function getPositionNotionalAndUnrealizedPnl(
        IExchange _exchange,
        ISakePerpTypes.Position memory _position,
        ISakePerpTypes.PnlCalcOption _pnlCalcOption
    )
        public
        view
        override
        onlySakePerp
        returns (Decimal.decimal memory positionNotional, SignedDecimal.signedDecimal memory unrealizedPnl)
    {
        Decimal.decimal memory positionSizeAbs = _position.size.abs();
        if (positionSizeAbs.toUint() != 0) {
            bool isShortPosition = _position.size.toInt() < 0;
            IExchangeTypes.Dir dir =
                isShortPosition ? IExchangeTypes.Dir.REMOVE_FROM_AMM : IExchangeTypes.Dir.ADD_TO_AMM;
            if (_pnlCalcOption == ISakePerpTypes.PnlCalcOption.TWAP) {
                positionNotional = _exchange.getOutputTwap(dir, positionSizeAbs);
            } else if (_pnlCalcOption == ISakePerpTypes.PnlCalcOption.SPOT_PRICE) {
                positionNotional = _exchange.getOutputPrice(dir, positionSizeAbs);
            } else {
                Decimal.decimal memory oraclePrice = _exchange.getUnderlyingPrice();
                positionNotional = positionSizeAbs.mulD(oraclePrice);
            }
            // unrealizedPnlForLongPosition = positionNotional - openNotional
            // unrealizedPnlForShortPosition = positionNotionalWhenBorrowed - positionNotionalWhenReturned =
            // openNotional - positionNotional = unrealizedPnlForLongPosition * -1
            unrealizedPnl = isShortPosition
                ? MixedDecimal.fromDecimal(_position.openNotional).subD(positionNotional)
                : MixedDecimal.fromDecimal(positionNotional).subD(_position.openNotional);
        }
    }

    function calcPositionAfterLiquidityMigration(
        IExchange _exchange,
        ISakePerpTypes.Position memory _position,
        uint256 _latestLiquidityIndex
    ) public view override onlySakePerp returns (ISakePerpTypes.Position memory) {
        if (_position.size.toInt() == 0) {
            _position.liquidityHistoryIndex = _latestLiquidityIndex;
            return _position;
        }

        // get the change in exchange notional value
        // notionalDelta = current cumulative notional - cumulative notional of last snapshot
        IExchange.LiquidityChangedSnapshot memory lastSnapshot =
            _exchange.getLiquidityChangedSnapshots(_position.liquidityHistoryIndex);
        SignedDecimal.signedDecimal memory notionalDelta =
            _exchange.getCumulativeNotional().subD(lastSnapshot.cumulativeNotional);

        // update the old curve's reserve
        // by applying notionalDelta to the old curve
        Decimal.decimal memory updatedOldBaseReserve;
        Decimal.decimal memory updatedOldQuoteReserve;
        if (notionalDelta.toInt() != 0) {
            Decimal.decimal memory baseAssetWorth =
                _exchange.getInputPriceWithReserves(
                    notionalDelta.toInt() > 0 ? IExchangeTypes.Dir.ADD_TO_AMM : IExchangeTypes.Dir.REMOVE_FROM_AMM,
                    notionalDelta.abs(),
                    lastSnapshot.quoteAssetReserve,
                    lastSnapshot.baseAssetReserve
                );
            updatedOldQuoteReserve = notionalDelta.addD(lastSnapshot.quoteAssetReserve).abs();
            if (notionalDelta.toInt() > 0) {
                updatedOldBaseReserve = lastSnapshot.baseAssetReserve.subD(baseAssetWorth);
            } else {
                updatedOldBaseReserve = lastSnapshot.baseAssetReserve.addD(baseAssetWorth);
            }
        } else {
            updatedOldQuoteReserve = lastSnapshot.quoteAssetReserve;
            updatedOldBaseReserve = lastSnapshot.baseAssetReserve;
        }

        // calculate the new position size
        _position.size = _exchange.calcBaseAssetAfterLiquidityMigration(
            _position.size,
            updatedOldQuoteReserve,
            updatedOldBaseReserve
        );
        _position.liquidityHistoryIndex = _latestLiquidityIndex;
        return _position;
    }

    function calcPositionAfterLiquidityMigrationWithoutNew(
        IExchange _exchange,
        ISakePerpTypes.Position memory _position,
        uint256 _latestLiquidityIndex
    ) public override onlySakePerp returns (SignedDecimal.signedDecimal memory) {
        IExchange.LiquidityChangedSnapshot memory latestSnapshot =
            _exchange.getLiquidityChangedSnapshots(_latestLiquidityIndex);
        SignedDecimal.signedDecimal memory notionalDelta = snapshotDeltaPosNotional[_position.liquidityHistoryIndex];
        bool isPositiveValue = _position.size.toInt() > 0 ? true : false;
        Decimal.decimal memory posNotional;

        {
            IExchange.LiquidityChangedSnapshot memory lastSnapshot =
                _exchange.getLiquidityChangedSnapshots(_position.liquidityHistoryIndex);
            SignedDecimal.signedDecimal memory totalDelta =
                latestSnapshot.cumulativeNotional.subD(lastSnapshot.cumulativeNotional).addD(notionalDelta);

            // update the old curve's reserve
            // by applying totalDelta to the old curve
            Decimal.decimal memory updatedOldBaseReserve;
            Decimal.decimal memory updatedOldQuoteReserve;
            if (totalDelta.toInt() != 0) {
                Decimal.decimal memory baseAssetWorth =
                    _exchange.getInputPriceWithReserves(
                        totalDelta.toInt() > 0 ? IExchangeTypes.Dir.ADD_TO_AMM : IExchangeTypes.Dir.REMOVE_FROM_AMM,
                        totalDelta.abs(),
                        lastSnapshot.quoteAssetReserve,
                        lastSnapshot.baseAssetReserve
                    );
                updatedOldQuoteReserve = totalDelta.addD(lastSnapshot.quoteAssetReserve).abs();
                if (totalDelta.toInt() > 0) {
                    updatedOldBaseReserve = lastSnapshot.baseAssetReserve.subD(baseAssetWorth);
                } else {
                    updatedOldBaseReserve = lastSnapshot.baseAssetReserve.addD(baseAssetWorth);
                }
            } else {
                updatedOldQuoteReserve = lastSnapshot.quoteAssetReserve;
                updatedOldBaseReserve = lastSnapshot.baseAssetReserve;
            }

            // measure the trader position's notional value on the old curve
            // (by simulating closing the position)
            posNotional = _exchange.getOutputPriceWithReserves(
                isPositiveValue ? IExchangeTypes.Dir.ADD_TO_AMM : IExchangeTypes.Dir.REMOVE_FROM_AMM,
                _position.size.abs(),
                updatedOldQuoteReserve,
                updatedOldBaseReserve
            );

            SignedDecimal.signedDecimal memory _posNotional = MixedDecimal.fromDecimal(posNotional);
            if (isPositiveValue) {
                _posNotional = _posNotional.mulScalar(-1);
            }
            snapshotDeltaPosNotional[_position.liquidityHistoryIndex] = snapshotDeltaPosNotional[
                _position.liquidityHistoryIndex
            ]
                .addD(_posNotional);
        }

        {
            Decimal.decimal memory updatedNewBaseReserve;
            Decimal.decimal memory updatedNewQuoteReserve;
            if (notionalDelta.toInt() != 0) {
                Decimal.decimal memory baseAssetWorth =
                    _exchange.getInputPriceWithReserves(
                        notionalDelta.toInt() > 0 ? IExchangeTypes.Dir.ADD_TO_AMM : IExchangeTypes.Dir.REMOVE_FROM_AMM,
                        notionalDelta.abs(),
                        latestSnapshot.quoteAssetReserve,
                        latestSnapshot.baseAssetReserve
                    );
                updatedNewQuoteReserve = notionalDelta.addD(latestSnapshot.quoteAssetReserve).abs();
                if (notionalDelta.toInt() > 0) {
                    updatedNewBaseReserve = latestSnapshot.baseAssetReserve.subD(baseAssetWorth);
                } else {
                    updatedNewBaseReserve = latestSnapshot.baseAssetReserve.addD(baseAssetWorth);
                }
            } else {
                updatedNewQuoteReserve = latestSnapshot.quoteAssetReserve;
                updatedNewBaseReserve = latestSnapshot.baseAssetReserve;
            }

            // calculate and apply the required size on the new curve
            SignedDecimal.signedDecimal memory newBaseAsset =
                MixedDecimal.fromDecimal(
                    _exchange.getInputPriceWithReserves(
                        isPositiveValue ? IExchangeTypes.Dir.REMOVE_FROM_AMM : IExchangeTypes.Dir.ADD_TO_AMM,
                        posNotional,
                        updatedNewQuoteReserve,
                        updatedNewBaseReserve
                    )
                );

            return newBaseAsset.mulScalar(isPositiveValue ? 1 : int256(-1));
        }
    }

    function calcRemainMarginWithFundingPaymentAndOvernightFee(
        IExchange _exchange,
        ISakePerpTypes.Position memory _oldPosition,
        SignedDecimal.signedDecimal memory _marginDelta
    ) public view override onlySakePerp returns (RemainMarginInfo memory remainMarginInfo) {
        // calculate funding payment
        SignedDecimal.signedDecimal memory latestCumulativePremiumFraction =
            ISakePerp(SakePerp).getLatestCumulativePremiumFraction(_exchange);
        if (_oldPosition.size.toInt() != 0) {
            remainMarginInfo.fundingPayment = latestCumulativePremiumFraction
                .subD(_oldPosition.lastUpdatedCumulativePremiumFraction)
                .mulD(_oldPosition.size);
        }

        // calculate overnight feerate
        // Overnight Fee = openNotional * overnight fee rate
        Decimal.decimal memory latestCumulativeOvernightFeeRate =
            ISakePerp(SakePerp).getLatestCumulativeOvernightFeeRate(_exchange);
        if (_oldPosition.size.toInt() != 0) {
            remainMarginInfo.overnightFee = latestCumulativeOvernightFeeRate
                .subD(_oldPosition.lastUpdatedCumulativeOvernightFeeRate)
                .mulD(_oldPosition.openNotional);
        }

        // calculate remain margin
        SignedDecimal.signedDecimal memory signedRemainMargin =
            _marginDelta.subD(remainMarginInfo.fundingPayment).subD(remainMarginInfo.overnightFee).addD(
                _oldPosition.margin
            );

        // if remain margin is negative, set to zero and leave the rest to bad debt
        if (signedRemainMargin.toInt() < 0) {
            remainMarginInfo.badDebt = signedRemainMargin.abs();
        } else {
            remainMarginInfo.remainMargin = signedRemainMargin.abs();
        }
    }
}

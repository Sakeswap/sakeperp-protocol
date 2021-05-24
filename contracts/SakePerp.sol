// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./utils/Decimal.sol";
import "./utils/SignedDecimal.sol";
import "./utils/MixedDecimal.sol";
import "./utils/BlockContext.sol";
import "./interface/IExchange.sol";
import "./interface/IInsuranceFund.sol";
import "./interface/ISystemSettings.sol";
import "./interface/ISakePerpVault.sol";
import "./interface/ISakePerp.sol";
import "./interface/ISakePerpState.sol";
import "./types/IExchangeTypes.sol";
import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// note BaseRelayRecipient must come after OwnerPausableUpgradeSafe so its msg.sender takes precedence
// (yes, the ordering is reversed comparing to Python)
contract SakePerp is ISakePerp, OwnableUpgradeable, BlockContext {
    using Decimal for Decimal.decimal;
    using SignedDecimal for SignedDecimal.signedDecimal;
    using MixedDecimal for SignedDecimal.signedDecimal;
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeMathUpgradeable for uint256;
    //
    // EVENTS
    //
    event MarginChanged(
        address indexed sender,
        address indexed exchange,
        int256 amount,
        int256 fundingPayment,
        uint256 overnightFee
    );
    event PositionAdjusted(
        address indexed exchange,
        address indexed trader,
        int256 newPositionSize,
        uint256 oldLiquidityIndex,
        uint256 newLiquidityIndex
    );
    event PositionSettled(address indexed exchange, address indexed trader, uint256 valueTransferred);
    event RestrictionModeEntered(address exchange, uint256 blockNumber);

    /// @notice This event is emitted when position change
    /// @param trader the address which execute this transaction
    /// @param exchange IExchange address
    /// @param margin margin
    /// @param positionNotional margin * leverage
    /// @param exchangedPositionSize position size, e.g. ETHUSDC or LINKUSDC
    /// @param fee transaction fee
    /// @param positionSizeAfter position size after this transaction, might be increased or decreased
    /// @param realizedPnl realized pnl after this position changed
    /// @param unrealizedPnlAfter unrealized pnl after this position changed
    /// @param badDebt position change amount cleared by insurance funds
    /// @param liquidationPenalty amount of remaining margin lost due to liquidation
    /// @param spotPrice quote asset reserve / base asset reserve
    /// @param fundingPayment funding payment (+: trader paid, -: trader received)
    /// @param overnightPayment overnight payment
    event PositionChanged(
        address indexed trader,
        address indexed exchange,
        uint256 margin,
        uint256 positionNotional,
        int256 exchangedPositionSize,
        uint256 fee,
        int256 positionSizeAfter,
        int256 realizedPnl,
        int256 unrealizedPnlAfter,
        uint256 badDebt,
        uint256 liquidationPenalty,
        uint256 spotPrice,
        int256 fundingPayment,
        uint256 overnightPayment
    );

    /// @notice This event is emitted when position liquidated
    /// @param trader the account address being liquidated
    /// @param exchange IExchange address
    /// @param positionNotional liquidated position value minus liquidationFee
    /// @param positionSize liquidated position size
    /// @param liquidationFee liquidation fee to the liquidator
    /// @param liquidator the address which execute this transaction
    /// @param badDebt liquidation fee amount cleared by insurance funds
    event PositionLiquidated(
        address indexed trader,
        address indexed exchange,
        uint256 positionNotional,
        uint256 positionSize,
        uint256 liquidationFee,
        address liquidator,
        uint256 badDebt
    );

    /// @notice This event is emitted when overnight fee payed
    /// @param exchange exchange address
    /// @param totalOpenNotional the total open notional
    /// @param overnightFee the total overinight fee this time
    /// @param rate current overnight feerate
    event OvernightFeePayed(address indexed exchange, uint256 totalOpenNotional, uint256 overnightFee, uint256 rate);

    /// @notice This struct is used for avoiding stack too deep error when passing too many var between functions
    struct PositionResp {
        Position position;
        // the quote asset amount trader will send if open position, will receive if close
        Decimal.decimal exchangedQuoteAssetAmount;
        // if realizedPnl + realizedFundingPayment + margin is negative, it's the abs value of it
        Decimal.decimal badDebt;
        // the base asset amount trader will receive if open position, will send if close
        SignedDecimal.signedDecimal exchangedPositionSize;
        // funding payment incurred during this position response
        SignedDecimal.signedDecimal fundingPayment;
        // overnight payment incurred during this position response
        Decimal.decimal overnightFee;
        // realizedPnl = unrealizedPnl * closedRatio
        SignedDecimal.signedDecimal realizedPnl;
        // positive = trader transfer margin to vault, negative = trader receive margin from vault
        // it's 0 when internalReducePosition, its addedMargin when internalIncreasePosition
        // it's min(0, oldPosition + realizedFundingPayment + realizedPnl) when internalClosePosition
        SignedDecimal.signedDecimal marginToVault;
        // unrealized pnl after open position
        SignedDecimal.signedDecimal unrealizedPnlAfter;
    }

    struct ExchangeMap {
        // issue #1471
        // last block when it turn restriction mode on.
        // In restriction mode, no one can do multi open/close/liquidate position in the same block.
        // If any underwater position being closed (having a bad debt and make insuranceFund loss),
        // or any liquidation happened,
        // restriction mode is ON in that block and OFF(default) in the next block.
        // This design is to prevent the attacker being benefited from the multiple action in one block
        // in extreme cases
        uint256 lastRestrictionBlock;
        SignedDecimal.signedDecimal[] cumulativePremiumFractions;
        Decimal.decimal[] cumulativeOvernightFeerates;
        mapping(address => Position) positionMap;
        Decimal.decimal totalOpenNotional;
    }

    //**********************************************************//
    //    Can not change the order of below state variables     //
    //**********************************************************//
    // key by exchange address
    mapping(address => ExchangeMap) internal exchangeMap;

    ISystemSettings public systemSettings;

    ISakePerpVault public sakePerpVault;
    ISakePerpState public sakePerpState;

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private status;
    bool public paused;
    //**********************************************************//
    //    Can not change the order of above state variables     //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // FUNCTIONS
    //
    // openzeppelin doesn't support struct input
    // https://github.com/OpenZeppelin/openzeppelin-sdk/issues/1523
    function initialize(
        address _systemsettings,
        address _sakePerpVault,
        address _sakePerpState
    ) public initializer {
        __Ownable_init();

        systemSettings = ISystemSettings(_systemsettings);
        sakePerpVault = ISakePerpVault(_sakePerpVault);
        sakePerpState = ISakePerpState(_sakePerpState);
        status = _NOT_ENTERED;
        paused = false;
    }

    modifier nonReentrant() {
        // On the first call to nonReentrant, _notEntered will be true
        require(status != _ENTERED, "ReentrancyGuard: reentrant call");

        // Any calls to nonReentrant after this point will fail
        status = _ENTERED;

        _;

        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        status = _NOT_ENTERED;
    }

    modifier whenNotPaused() {
        require(!paused, "Pausable: paused");
        _;
    }

    //
    // External
    //
    /**
     * @dev set system settings
     */
    function setSystemSettings(ISystemSettings _systemSettings) external onlyOwner {
        systemSettings = _systemSettings;
    }

    /**
     * @notice add margin to increase margin ratio
     * @param _exchange IExchange address
     * @param _addedMargin added margin in 18 digits
     */
    function addMargin(IExchange _exchange, Decimal.decimal calldata _addedMargin)
        external
        whenNotPaused()
        nonReentrant()
    {
        // check condition
        requireExchange(_exchange, true);
        requireNonZeroInput(_addedMargin);

        // update margin part in personal position
        address trader = msg.sender;
        Position memory position = adjustPositionForLiquidityChanged(_exchange, trader);
        position.margin = position.margin.addD(_addedMargin);
        setPosition(_exchange, trader, position);

        // transfer token from trader
        IERC20Upgradeable(_exchange.quoteAsset()).safeTransferFrom(
            trader,
            address(sakePerpVault),
            _addedMargin.toUint()
        );

        emit MarginChanged(trader, address(_exchange), int256(_addedMargin.toUint()), 0, 0);
    }

    /**
     * @notice remove margin to decrease margin ratio
     * @param _exchange IExchange address
     * @param _removedMargin removed margin in 18 digits
     */
    function removeMargin(IExchange _exchange, Decimal.decimal calldata _removedMargin)
        external
        whenNotPaused()
        nonReentrant()
    {
        // check condition
        requireExchange(_exchange, true);
        requireNonZeroInput(_removedMargin);

        // update margin part in personal position
        address trader = msg.sender;
        Position memory position = adjustPositionForLiquidityChanged(_exchange, trader);

        // realize funding payment if there's no bad debt
        SignedDecimal.signedDecimal memory marginDelta = MixedDecimal.fromDecimal(_removedMargin).mulScalar(-1);
        ISakePerpState.RemainMarginInfo memory remainMarginInfo =
            sakePerpState.calcRemainMarginWithFundingPaymentAndOvernightFee(_exchange, position, marginDelta);
        require(remainMarginInfo.badDebt.toUint() == 0, "margin is not enough");

        position.margin = remainMarginInfo.remainMargin;
        position.lastUpdatedCumulativePremiumFraction = getLatestCumulativePremiumFraction(_exchange);
        position.lastUpdatedCumulativeOvernightFeeRate = getLatestCumulativeOvernightFeeRate(_exchange);
        setPosition(_exchange, trader, position);

        // check margin ratio
        requireMoreMarginRatio(getMarginRatio(_exchange, trader), _exchange.initMarginRatio(), true);

        // transfer token back to trader
        withdraw(_exchange, trader, _removedMargin);

        emit MarginChanged(
            trader,
            address(_exchange),
            marginDelta.toInt(),
            remainMarginInfo.fundingPayment.toInt(),
            remainMarginInfo.overnightFee.toUint()
        );
    }

    /**
     * @notice settle all the positions when exchange is shutdown. The settlement price is according to IExchange.settlementPrice
     * @param _exchange IExchange address
     */
    function settlePosition(IExchange _exchange) external nonReentrant() {
        // check condition
        requireExchange(_exchange, false);

        address trader = msg.sender;
        Position memory pos = getPosition(_exchange, trader);
        requirePositionSize(pos.size);

        // update position
        clearPosition(_exchange, trader);

        // calculate settledValue
        // If Settlement Price = 0, everyone takes back her collateral.
        // else Returned Fund = Position Size * (Settlement Price - Open Price) + Collateral
        Decimal.decimal memory settlementPrice = _exchange.getSettlementPrice();
        Decimal.decimal memory settledValue;
        if (settlementPrice.toUint() == 0) {
            settledValue = pos.margin;
        } else {
            // returnedFund = positionSize * (settlementPrice - openPrice) + positionMargin
            // openPrice = positionOpenNotional / positionSize.abs()
            SignedDecimal.signedDecimal memory returnedFund =
                pos
                    .size
                    .mulD(MixedDecimal.fromDecimal(settlementPrice).subD(pos.openNotional.divD(pos.size.abs())))
                    .addD(pos.margin);
            // if `returnedFund` is negative, trader can't get anything back
            if (returnedFund.toInt() > 0) {
                settledValue = returnedFund.abs();
            }
        }

        // transfer token based on settledValue. no insurance fund support
        if (settledValue.toUint() > 0) {
            withdraw(_exchange, trader, settledValue);
            //IERC20Upgradeable(_exchange.quoteAsset()).safeTransfer(trader, settledValue.toUint());
        }

        // emit event
        emit PositionSettled(address(_exchange), trader, settledValue.toUint());
    }

    // if increase position
    //   marginToVault = addMargin
    //   marginDiff = realizedFundingPayment + realizedPnl(0)
    //   pos.margin += marginToVault + marginDiff
    //   vault.margin += marginToVault + marginDiff
    //   required(enoughMarginRatio)
    // else if reduce position()
    //   marginToVault = 0
    //   marginDiff = realizedFundingPayment + realizedPnl
    //   pos.margin += marginToVault + marginDiff
    //   if pos.margin < 0, badDebt = abs(pos.margin), set pos.margin = 0
    //   vault.margin += marginToVault + marginDiff
    //   required(enoughMarginRatio)
    // else if close
    //   marginDiff = realizedFundingPayment + realizedPnl
    //   pos.margin += marginDiff
    //   if pos.margin < 0, badDebt = abs(pos.margin)
    //   marginToVault = -pos.margin
    //   set pos.margin = 0
    //   vault.margin += marginToVault + marginDiff
    // else if close and open a larger position in reverse side
    //   close()
    //   positionNotional -= exchangedQuoteAssetAmount
    //   newMargin = positionNotional / leverage
    //   internalIncreasePosition(newMargin, leverage)
    // else if liquidate
    //   close()
    //   pay liquidation fee to liquidator
    //   move the remain margin to insuranceFund

    /**
     * @notice open a position
     * @param _exchange exchange address
     * @param _side enum Side; BUY for long and SELL for short
     * @param _quoteAssetAmount quote asset amount in 18 digits. Can Not be 0
     * @param _leverage leverage  in 18 digits. Can Not be 0
     * @param _baseAssetAmountLimit minimum base asset amount expected to get to prevent from slippage.
     */
    function openPosition(
        IExchange _exchange,
        Side _side,
        Decimal.decimal calldata _quoteAssetAmount,
        Decimal.decimal calldata _leverage,
        Decimal.decimal calldata _baseAssetAmountLimit
    ) external whenNotPaused() nonReentrant() {
        requireExchange(_exchange, true);
        requireNonZeroInput(_quoteAssetAmount);
        requireNonZeroInput(_leverage);
        requireMoreMarginRatio(
            MixedDecimal.fromDecimal(Decimal.one()).divD(_leverage),
            _exchange.initMarginRatio(),
            true
        );
        requireNotRestrictionMode(_exchange);

        address trader = msg.sender;
        require(
            sakePerpState.checkWaitingPeriod(address(_exchange), trader, _side),
            "cannot open position during waiting period"
        );

        PositionResp memory positionResp;
        {
            // add scope for stack too deep error
            int256 oldPositionSize = adjustPositionForLiquidityChanged(_exchange, trader).size.toInt();
            bool isNewPosition = oldPositionSize == 0 ? true : false;
            if (!isNewPosition) {
                requireMoreMarginRatio(getMarginRatio(_exchange, trader), _exchange.maintenanceMarginRatio(), true);
            }

            // increase or decrease position depends on old position's side and size
            if (isNewPosition || (oldPositionSize > 0 ? Side.BUY : Side.SELL) == _side) {
                positionResp = internalIncreasePosition(
                    _exchange,
                    _side,
                    _quoteAssetAmount.mulD(_leverage),
                    _baseAssetAmountLimit,
                    _leverage
                );
            } else {
                positionResp = openReversePosition(
                    _exchange,
                    _side,
                    _quoteAssetAmount,
                    _leverage,
                    _baseAssetAmountLimit
                );
            }

            // update the position state
            setPosition(_exchange, trader, positionResp.position);

            // to prevent attacker to leverage the bad debt to withdraw extra token from  insurance fund
            if (positionResp.badDebt.toUint() > 0) {
                enterRestrictionMode(_exchange);
            }

            //ransfer the actual token between trader and vault
            IERC20Upgradeable quoteToken = _exchange.quoteAsset();
            if (positionResp.marginToVault.toInt() > 0) {
                quoteToken.safeTransferFrom(trader, address(sakePerpVault), positionResp.marginToVault.abs().toUint());
            } else if (positionResp.marginToVault.toInt() < 0) {
                withdraw(_exchange, trader, positionResp.marginToVault.abs());
            }

            //check MM
            sakePerpVault.requireMMNotBankrupt(address(_exchange));
        }

        // calculate fee and transfer token for fees
        //@audit - can optimize by changing amm.swapInput/swapOutput's return type to (exchangedAmount, quoteToll, quoteSpread, quoteReserve, baseReserve) (@wraecca)
        Decimal.decimal memory transferredFee = transferFee(trader, _exchange, positionResp.exchangedQuoteAssetAmount);

        // emit event
        uint256 spotPrice = _exchange.getSpotPrice().toUint();
        int256 fundingPayment = positionResp.fundingPayment.toInt(); // pre-fetch for stack too deep error
        uint256 overnightFee = positionResp.overnightFee.toUint();
        emit PositionChanged(
            trader,
            address(_exchange),
            positionResp.position.margin.toUint(),
            positionResp.exchangedQuoteAssetAmount.toUint(),
            positionResp.exchangedPositionSize.toInt(),
            transferredFee.toUint(),
            positionResp.position.size.toInt(),
            positionResp.realizedPnl.toInt(),
            positionResp.unrealizedPnlAfter.toInt(),
            positionResp.badDebt.toUint(),
            0,
            spotPrice,
            fundingPayment,
            overnightFee
        );
    }

    /**
     * @notice close all the positions
     * @param _exchange IExchange address
     */
    function closePosition(IExchange _exchange, Decimal.decimal calldata _quoteAssetAmountLimit)
        external
        whenNotPaused()
        nonReentrant()
    {
        // check conditions
        requireExchange(_exchange, true);
        requireNotRestrictionMode(_exchange);

        // update position
        address trader = msg.sender;
        Position memory position = adjustPositionForLiquidityChanged(_exchange, trader);
        Side _side = position.size.isNegative() ? Side.BUY : Side.SELL;
        require(
            sakePerpState.checkWaitingPeriod(address(_exchange), trader, _side),
            "cannot close position during waiting period"
        );

        PositionResp memory positionResp = internalClosePosition(_exchange, trader, _quoteAssetAmountLimit, true);

        {
            // add scope for stack too deep error
            // transfer the actual token from trader and vault
            if (positionResp.badDebt.toUint() > 0) {
                enterRestrictionMode(_exchange);
                realizeBadDebt(_exchange, positionResp.badDebt);
            }
            withdraw(_exchange, trader, positionResp.marginToVault.abs());
        }

        //check MM
        sakePerpVault.requireMMNotBankrupt(address(_exchange));

        // calculate fee and transfer token for fees
        Decimal.decimal memory transferredFee = transferFee(trader, _exchange, positionResp.exchangedQuoteAssetAmount);

        {
            // avoid stack too deep
            // prepare event
            uint256 spotPrice = _exchange.getSpotPrice().toUint();
            int256 fundingPayment = positionResp.fundingPayment.toInt();
            uint256 overnightFee = positionResp.overnightFee.toUint();
            emit PositionChanged(
                trader,
                address(_exchange),
                0, // margin
                positionResp.exchangedQuoteAssetAmount.toUint(),
                positionResp.exchangedPositionSize.toInt(),
                transferredFee.toUint(),
                positionResp.position.size.toInt(),
                positionResp.realizedPnl.toInt(),
                0, // unrealizedPnl
                positionResp.badDebt.toUint(),
                0,
                spotPrice,
                fundingPayment,
                overnightFee
            );
        }
    }

    /**
     * @notice liquidate trader's underwater position. Require trader's margin ratio less than maintenance margin ratio
     * @dev liquidator can NOT open any positions in the same block to prevent from price manipulation.
     * @param _exchange IExchange address
     * @param _trader trader address
     */
    function liquidate(IExchange _exchange, address _trader) external nonReentrant() {
        // check conditions
        requireExchange(_exchange, true);
        {
            SignedDecimal.signedDecimal memory marginRatio = getMarginRatio(_exchange, _trader);

            // including oracle-based margin ratio as reference price when amm is over spread limit
            if (_exchange.isOverSpreadLimit()) {
                SignedDecimal.signedDecimal memory marginRatioBasedOnOracle = getMarginRatioBasedOnOracle(_exchange, _trader);
                if (marginRatioBasedOnOracle.subD(marginRatio).toInt() > 0) {
                    marginRatio = marginRatioBasedOnOracle;
                }
            }
            requireMoreMarginRatio(marginRatio, _exchange.maintenanceMarginRatio(), false);
        }

        // update states
        adjustPositionForLiquidityChanged(_exchange, _trader);
        PositionResp memory positionResp = internalClosePosition(_exchange, _trader, Decimal.zero(), false);
        enterRestrictionMode(_exchange);

        {
            // avoid stack too deep
            // Amount pay to liquidator
            Decimal.decimal memory liquidationFee =
                positionResp.exchangedQuoteAssetAmount.mulD(_exchange.liquidationFeeRatio());
            if (liquidationFee.cmp(_exchange.maxLiquidationFee()) > 0) {
                liquidationFee = _exchange.maxLiquidationFee();
            }

            // neither trader nor liquidator should pay anything for liquidating position
            // in here, -marginToVault means remainMargin

            Decimal.decimal memory remainMargin = positionResp.marginToVault.abs();
            // add scope for stack too deep error
            // if the remainMargin is not enough for liquidationFee, count it as bad debt
            // else, then the rest will be transferred to insuranceFund
            Decimal.decimal memory liquidationBadDebt;
            Decimal.decimal memory totalBadDebt = positionResp.badDebt;
            SignedDecimal.signedDecimal memory totalMarginToVault = positionResp.marginToVault;
            if (liquidationFee.toUint() > remainMargin.toUint()) {
                liquidationBadDebt = liquidationFee.subD(remainMargin);
                totalBadDebt = totalBadDebt.addD(liquidationBadDebt);
            } else {
                totalMarginToVault = totalMarginToVault.addD(liquidationFee);
            }

            // transfer the actual token between trader and vault
            if (totalBadDebt.toUint() > 0) {
                realizeBadDebt(_exchange, totalBadDebt);
            }
            if (totalMarginToVault.toInt() < 0) {
                transferToInsuranceFund(_exchange, totalMarginToVault.abs());
            }
            withdraw(_exchange, msg.sender, liquidationFee);

            emit PositionLiquidated(
                _trader,
                address(_exchange),
                positionResp.exchangedQuoteAssetAmount.toUint(),
                positionResp.exchangedPositionSize.toUint(),
                liquidationFee.toUint(),
                msg.sender,
                liquidationBadDebt.toUint()
            );
        }

        {
            emit PositionChanged(
                _trader,
                address(_exchange),
                0,
                positionResp.exchangedQuoteAssetAmount.toUint(),
                positionResp.exchangedPositionSize.toInt(),
                0,
                0,
                positionResp.realizedPnl.toInt(),
                0,
                positionResp.badDebt.toUint(),
                positionResp.marginToVault.abs().toUint(),
                _exchange.getSpotPrice().toUint(),
                positionResp.fundingPayment.toInt(),
                positionResp.overnightFee.toUint()
            );
        }
    }

    /**
     * @notice if funding rate is positive, traders with long position pay traders with short position and vice versa.
     * @param _exchange IExchange address
     */
    function payFunding(IExchange _exchange) external {
        requireExchange(_exchange, true);

        SignedDecimal.signedDecimal memory baseAssetDelta = _exchange.getTotalPositionSize();
        SignedDecimal.signedDecimal memory premiumFraction = _exchange.settleFunding();
        exchangeMap[address(_exchange)].cumulativePremiumFractions.push(
            premiumFraction.addD(getLatestCumulativePremiumFraction(_exchange))
        );

        // funding payment = premium fraction * position
        // eg. if alice takes 10 long position, baseAssetDelta = 10
        // if premiumFraction is positive: long pay short, amm get positive funding payment
        // if premiumFraction is negative: short pay long, amm get negative funding payment
        // if position side * premiumFraction < 0, funding payment is negative which means loss
        SignedDecimal.signedDecimal memory ammFundingPaymentLoss = premiumFraction.mulD(baseAssetDelta);

        if (ammFundingPaymentLoss.toInt() < 0) {
            realizeBadDebt(_exchange, ammFundingPaymentLoss.abs());
        } else {
            handleFundingFeeAndOvernightFee(
                _exchange,
                ammFundingPaymentLoss.abs(),
                systemSettings.fundingFeeLpShareRatio()
            );
            // address insuranceFundAddress = address(systemSettings.getInsuranceFund(_exchange));
            // require(insuranceFundAddress != address(0), "Invalid InsuranceFund");
            // Decimal.decimal memory insuranceFundFee =
            //     ammFundingPaymentLoss.abs().mulD(systemSettings.fundingFeeLpShareRatio());
            // sakePerpVault.withdraw(_exchange.quoteAsset(), insuranceFundAddress, insuranceFundFee);
            // Decimal.decimal memory fundingFee = ammFundingPaymentLoss.abs().subD(insuranceFundFee);
            // sakePerpVault.addCachedLiquidity(_exchange, fundingFee);
        }
    }

    /**
     * @notice if overnight fee rate is positive, traders with long position pay traders with short position and vice versa.
     * @param _exchange IExchange address
     */
    function payOvernightFee(IExchange _exchange) external {
        requireExchange(_exchange, true);
        systemSettings.setNextOvernightFeeTime(_exchange);

        Decimal.decimal memory overnightFeeRate = systemSettings.overnightFeeRatio();
        exchangeMap[address(_exchange)].cumulativeOvernightFeerates.push(
            overnightFeeRate.addD(getLatestCumulativeOvernightFeeRate(_exchange))
        );

        Decimal.decimal memory totalOpenNotional = exchangeMap[address(_exchange)].totalOpenNotional;
        Decimal.decimal memory exchageOvernightPayment = overnightFeeRate.mulD(totalOpenNotional);

        if (exchageOvernightPayment.toUint() > 0) {
            handleFundingFeeAndOvernightFee(
                _exchange,
                exchageOvernightPayment,
                systemSettings.overnightFeeLpShareRatio()
            );
        }

        emit OvernightFeePayed(
            address(_exchange),
            totalOpenNotional.toUint(),
            exchageOvernightPayment.toUint(),
            overnightFeeRate.toUint()
        );
    }

    /**
     * @notice adjust msg.sender's position when liquidity migration happened
     * @param _exchange Exchange address
     */
    function adjustPosition(IExchange _exchange) external {
        adjustPositionForLiquidityChanged(_exchange, msg.sender);
    }

    //
    // VIEW FUNCTIONS
    //
    /**
     * @notice get margin ratio, marginRatio = (margin + funding payments + unrealized Pnl) / openNotional
     * use spot and twap price to calculate unrealized Pnl, final unrealized Pnl depends on which one is higher
     * @param _exchange IExchange address
     * @param _trader trader address
     * @return margin ratio in 18 digits
     */
    function getMarginRatio(IExchange _exchange, address _trader)
        public
        view
        override
        returns (SignedDecimal.signedDecimal memory)
    {
        Position memory position = getPosition(_exchange, _trader);
        requirePositionSize(position.size);
        requireNonZeroInput(position.openNotional);

        (Decimal.decimal memory spotPositionNotional, SignedDecimal.signedDecimal memory spotPricePnl) =
            (getPositionNotionalAndUnrealizedPnl(_exchange, _trader, PnlCalcOption.SPOT_PRICE));
        (Decimal.decimal memory twapPositionNotional, SignedDecimal.signedDecimal memory twapPricePnl) =
            (getPositionNotionalAndUnrealizedPnl(_exchange, _trader, PnlCalcOption.TWAP));
        (SignedDecimal.signedDecimal memory unrealizedPnl, Decimal.decimal memory positionNotional) =
            spotPricePnl.toInt() > twapPricePnl.toInt()
                ? (spotPricePnl, spotPositionNotional)
                : (twapPricePnl, twapPositionNotional);

        return _getMarginRatio(_exchange, position, unrealizedPnl, positionNotional);
    }

    function getMarginRatioBasedOnOracle(IExchange _exchange, address _trader)
        public
        view
        returns (SignedDecimal.signedDecimal memory)
    {
        Position memory position = getPosition(_exchange, _trader);
        requirePositionSize(position.size);
        (Decimal.decimal memory oraclePositionNotional, SignedDecimal.signedDecimal memory oraclePricePnl) =
            (getPositionNotionalAndUnrealizedPnl(_exchange, _trader, PnlCalcOption.ORACLE));
        return _getMarginRatio(_exchange, position, oraclePricePnl, oraclePositionNotional);
    }

    function _getMarginRatio(
        IExchange _exchange,
        Position memory _position,
        SignedDecimal.signedDecimal memory _unrealizedPnl,
        Decimal.decimal memory _positionNotional
    ) internal view returns (SignedDecimal.signedDecimal memory) {
        ISakePerpState.RemainMarginInfo memory remainMarginInfo =
            sakePerpState.calcRemainMarginWithFundingPaymentAndOvernightFee(_exchange, _position, _unrealizedPnl);
        return
            MixedDecimal.fromDecimal(remainMarginInfo.remainMargin).subD(remainMarginInfo.badDebt).divD(
                _positionNotional
            );
    }

    /**
     * @notice get personal position information, and adjust size if migration is necessary
     * @param _exchange IExchange address
     * @param _trader trader address
     * @return struct Position
     */
    function getPosition(IExchange _exchange, address _trader) public view override returns (Position memory) {
        Position memory pos = getUnadjustedPosition(_exchange, _trader);
        uint256 latestLiquidityIndex = _exchange.getLiquidityHistoryLength().sub(1);
        if (pos.liquidityHistoryIndex == latestLiquidityIndex) {
            return pos;
        }

        return sakePerpState.calcPositionAfterLiquidityMigration(_exchange, pos, latestLiquidityIndex);
    }

    /**
     * @notice get position notional and unrealized Pnl without fee expense and funding payment
     * @param _exchange IExchange address
     * @param _trader trader address
     * @param _pnlCalcOption enum PnlCalcOption, SPOT_PRICE for spot price and TWAP for twap price
     * @return positionNotional position notional
     * @return unrealizedPnl unrealized Pnl
     */
    function getPositionNotionalAndUnrealizedPnl(
        IExchange _exchange,
        address _trader,
        PnlCalcOption _pnlCalcOption
    )
        public
        view
        override
        returns (Decimal.decimal memory positionNotional, SignedDecimal.signedDecimal memory unrealizedPnl)
    {
        Position memory position = getPosition(_exchange, _trader);
        return sakePerpState.getPositionNotionalAndUnrealizedPnl(_exchange, position, _pnlCalcOption);
    }

    /**
     * @notice get latest cumulative premium fraction.
     * @param _exchange IExchange address
     * @return latest cumulative premium fraction in 18 digits
     */
    function getLatestCumulativePremiumFraction(IExchange _exchange)
        public
        view
        override
        returns (SignedDecimal.signedDecimal memory)
    {
        uint256 len = exchangeMap[address(_exchange)].cumulativePremiumFractions.length;
        if (len > 0) {
            return exchangeMap[address(_exchange)].cumulativePremiumFractions[len - 1];
        }
    }

    /**
     * @notice get latest cumulative overnight feerate.
     * @param _exchange IExchange address
     * @return latest cumulative overnight feerate in 18 digits
     */
    function getLatestCumulativeOvernightFeeRate(IExchange _exchange)
        public
        view
        override
        returns (Decimal.decimal memory)
    {
        uint256 len = exchangeMap[address(_exchange)].cumulativeOvernightFeerates.length;
        if (len > 0) {
            return exchangeMap[address(_exchange)].cumulativeOvernightFeerates[len - 1];
        }
    }

    /**
     * @notice get MM liquidity.
     * @param _exchange IExchange address
     * @return MM liquidity in 18 digits
     *
     */
    function getMMLiquidity(address _exchange) public view override returns (SignedDecimal.signedDecimal memory) {
        return sakePerpVault.getTotalMMLiquidity(_exchange);
    }

    //
    // INTERNAL FUNCTIONS
    //

    function enterRestrictionMode(IExchange _exchange) internal {
        uint256 blockNumber = _blockNumber();
        exchangeMap[address(_exchange)].lastRestrictionBlock = blockNumber;
        emit RestrictionModeEntered(address(_exchange), blockNumber);
    }

    function setPosition(
        IExchange _exchange,
        address _trader,
        Position memory _position
    ) internal {
        Position storage positionStorage = exchangeMap[address(_exchange)].positionMap[_trader];
        exchangeMap[address(_exchange)].totalOpenNotional = exchangeMap[address(_exchange)].totalOpenNotional.subD(
            positionStorage.openNotional
        );
        positionStorage.size = _position.size;
        positionStorage.margin = _position.margin;
        positionStorage.openNotional = _position.openNotional;
        positionStorage.lastUpdatedCumulativePremiumFraction = _position.lastUpdatedCumulativePremiumFraction;
        positionStorage.lastUpdatedCumulativeOvernightFeeRate = _position.lastUpdatedCumulativeOvernightFeeRate;
        positionStorage.blockNumber = _position.blockNumber;
        positionStorage.liquidityHistoryIndex = _position.liquidityHistoryIndex;
        exchangeMap[address(_exchange)].totalOpenNotional = exchangeMap[address(_exchange)].totalOpenNotional.addD(
            positionStorage.openNotional
        );
    }

    function clearPosition(IExchange _exchange, address _trader) internal {
        Position memory position = exchangeMap[address(_exchange)].positionMap[_trader];
        exchangeMap[address(_exchange)].totalOpenNotional = exchangeMap[address(_exchange)].totalOpenNotional.subD(
            position.openNotional
        );

        // keep the record in order to retain the last updated block number
        exchangeMap[address(_exchange)].positionMap[_trader] = Position({
            size: SignedDecimal.zero(),
            margin: Decimal.zero(),
            openNotional: Decimal.zero(),
            lastUpdatedCumulativePremiumFraction: SignedDecimal.zero(),
            lastUpdatedCumulativeOvernightFeeRate: Decimal.zero(),
            blockNumber: _blockNumber(),
            liquidityHistoryIndex: 0
        });
    }

    // only called from openPosition and closeAndOpenReversePosition. caller need to ensure there's enough marginRatio
    function internalIncreasePosition(
        IExchange _exchange,
        Side _side,
        Decimal.decimal memory _openNotional,
        Decimal.decimal memory _minPositionSize,
        Decimal.decimal memory _leverage
    ) internal returns (PositionResp memory positionResp) {
        address trader = msg.sender;
        Position memory oldPosition = getUnadjustedPosition(_exchange, trader);
        positionResp.exchangedPositionSize = swapInput(_exchange, _side, _openNotional, _minPositionSize);
        SignedDecimal.signedDecimal memory newSize = oldPosition.size.addD(positionResp.exchangedPositionSize);
        // if size is 0 (means a new position), set the latest liquidity index
        uint256 liquidityHistoryIndex = oldPosition.liquidityHistoryIndex;
        if (oldPosition.size.toInt() == 0) {
            liquidityHistoryIndex = _exchange.getLiquidityHistoryLength().sub(1);
        }

        sakePerpState.updateOpenInterestNotional(_exchange, MixedDecimal.fromDecimal(_openNotional));
        // if the trader is not in the whitelist, check max position size
        if (trader != sakePerpState.getWhiteList()) {
            Decimal.decimal memory maxHoldingBaseAsset = _exchange.getMaxHoldingBaseAsset();
            if (maxHoldingBaseAsset.toUint() > 0) {
                // total position size should be less than `positionUpperBound`
                require(newSize.abs().cmp(maxHoldingBaseAsset) <= 0, "hit position size upper bound");
            }
        }

        Position memory position;
        {
            //avoid stakc too deep
            SignedDecimal.signedDecimal memory increaseMarginRequirement =
                MixedDecimal.fromDecimal(_openNotional.divD(_leverage));

            ISakePerpState.RemainMarginInfo memory remainMarginInfo =
                sakePerpState.calcRemainMarginWithFundingPaymentAndOvernightFee(
                    _exchange,
                    oldPosition,
                    increaseMarginRequirement
                );

            positionResp.marginToVault = increaseMarginRequirement;
            positionResp.fundingPayment = remainMarginInfo.fundingPayment;
            positionResp.overnightFee = remainMarginInfo.overnightFee;

            position.margin = remainMarginInfo.remainMargin;
        }

        {
            //avoid stack too deep
            (, SignedDecimal.signedDecimal memory unrealizedPnl) =
                getPositionNotionalAndUnrealizedPnl(_exchange, trader, PnlCalcOption.SPOT_PRICE);
            positionResp.unrealizedPnlAfter = unrealizedPnl;
        }

        // update positionResp
        positionResp.exchangedQuoteAssetAmount = _openNotional;
        position.size = newSize;
        position.openNotional = oldPosition.openNotional.addD(positionResp.exchangedQuoteAssetAmount);
        position.liquidityHistoryIndex = liquidityHistoryIndex;
        position.lastUpdatedCumulativePremiumFraction = getLatestCumulativePremiumFraction(_exchange);
        position.lastUpdatedCumulativeOvernightFeeRate = getLatestCumulativeOvernightFeeRate(_exchange);
        position.blockNumber = _blockNumber();
        positionResp.position = position;
    }

    function openReversePosition(
        IExchange _exchange,
        Side _side,
        Decimal.decimal memory _quoteAssetAmount,
        Decimal.decimal memory _leverage,
        Decimal.decimal memory _baseAssetAmountLimit
    ) internal returns (PositionResp memory) {
        Decimal.decimal memory openNotional = _quoteAssetAmount.mulD(_leverage);
        (Decimal.decimal memory oldPositionNotional, SignedDecimal.signedDecimal memory unrealizedPnl) =
            getPositionNotionalAndUnrealizedPnl(_exchange, msg.sender, PnlCalcOption.SPOT_PRICE);
        PositionResp memory positionResp;

        // reduce position if old position is larger
        if (oldPositionNotional.toUint() > openNotional.toUint()) {
            sakePerpState.updateOpenInterestNotional(_exchange, MixedDecimal.fromDecimal(openNotional).mulScalar(-1));
            Position memory oldPosition = getUnadjustedPosition(_exchange, msg.sender);
            positionResp.exchangedPositionSize = swapInput(_exchange, _side, openNotional, _baseAssetAmountLimit);

            // realizedPnl = unrealizedPnl * closedRatio
            // closedRatio = positionResp.exchangedPositionSiz / oldPosition.size
            if (oldPosition.size.toInt() != 0) {
                positionResp.realizedPnl = unrealizedPnl.mulD(positionResp.exchangedPositionSize.abs()).divD(
                    oldPosition.size.abs()
                );
            }

            //
            {
                //avoid stack too deep
                ISakePerpState.RemainMarginInfo memory remainMarginInfo =
                    sakePerpState.calcRemainMarginWithFundingPaymentAndOvernightFee(
                        _exchange,
                        oldPosition,
                        positionResp.realizedPnl
                    );

                positionResp.badDebt = remainMarginInfo.badDebt;
                positionResp.fundingPayment = remainMarginInfo.fundingPayment;
                positionResp.overnightFee = remainMarginInfo.overnightFee;
                positionResp.exchangedQuoteAssetAmount = openNotional;

                //stack too deep, temp use oldPosition
                oldPosition.margin = remainMarginInfo.remainMargin;
                //position.margin = remainMargin;
            }

            // positionResp.unrealizedPnlAfter = unrealizedPnl - realizedPnl
            positionResp.unrealizedPnlAfter = unrealizedPnl.subD(positionResp.realizedPnl);

            // calculate openNotional (it's different depends on long or short side)
            // long: unrealizedPnl = positionNotional - openNotional => openNotional = positionNotional - unrealizedPnl
            // short: unrealizedPnl = openNotional - positionNotional => openNotional = positionNotional + unrealizedPnl
            // positionNotional = oldPositionNotional - exchangedQuoteAssetAmount
            SignedDecimal.signedDecimal memory remainOpenNotional =
                oldPosition.size.toInt() > 0
                    ? MixedDecimal.fromDecimal(oldPositionNotional).subD(positionResp.exchangedQuoteAssetAmount).subD(
                        positionResp.unrealizedPnlAfter
                    )
                    : positionResp.unrealizedPnlAfter.addD(oldPositionNotional).subD(
                        positionResp.exchangedQuoteAssetAmount
                    );
            require(remainOpenNotional.toInt() > 0, "value of openNotional <= 0");

            {
                Position memory position;
                position.margin = oldPosition.margin;
                position.size = oldPosition.size.addD(positionResp.exchangedPositionSize);
                position.openNotional = remainOpenNotional.abs();
                position.liquidityHistoryIndex = oldPosition.liquidityHistoryIndex;
                position.lastUpdatedCumulativePremiumFraction = getLatestCumulativePremiumFraction(_exchange);
                position.lastUpdatedCumulativeOvernightFeeRate = getLatestCumulativeOvernightFeeRate(_exchange);
                position.blockNumber = _blockNumber();
                positionResp.position = position;
            }

            return positionResp;
        }

        return closeAndOpenReversePosition(_exchange, _side, _quoteAssetAmount, _leverage, _baseAssetAmountLimit);
    }

    function closeAndOpenReversePosition(
        IExchange _exchange,
        Side _side,
        Decimal.decimal memory _quoteAssetAmount,
        Decimal.decimal memory _leverage,
        Decimal.decimal memory _baseAssetAmountLimit
    ) internal returns (PositionResp memory positionResp) {
        // new position size is larger than or equal to the old position size
        // so either close or close then open a larger position
        PositionResp memory closePositionResp = internalClosePosition(_exchange, msg.sender, Decimal.zero(), true);
        // the old position is underwater. trader should close a position first
        require(closePositionResp.badDebt.toUint() == 0, "reduce an underwater position");

        // update open notional after closing position
        Decimal.decimal memory openNotional =
            _quoteAssetAmount.mulD(_leverage).subD(closePositionResp.exchangedQuoteAssetAmount);

        // if remain exchangedQuoteAssetAmount is too small (eg. 1wei) then the required margin might be 0
        // then the clearingHouse will stop opening position
        if (openNotional.divD(_leverage).toUint() == 0) {
            positionResp = closePositionResp;
        } else {
            Decimal.decimal memory updatedBaseAssetAmountLimit;
            if (_baseAssetAmountLimit.toUint() > closePositionResp.exchangedPositionSize.toUint()) {
                updatedBaseAssetAmountLimit = _baseAssetAmountLimit.subD(closePositionResp.exchangedPositionSize.abs());
            }

            PositionResp memory increasePositionResp =
                internalIncreasePosition(_exchange, _side, openNotional, updatedBaseAssetAmountLimit, _leverage);
            positionResp = PositionResp({
                position: increasePositionResp.position,
                exchangedQuoteAssetAmount: closePositionResp.exchangedQuoteAssetAmount.addD(
                    increasePositionResp.exchangedQuoteAssetAmount
                ),
                badDebt: closePositionResp.badDebt.addD(increasePositionResp.badDebt),
                fundingPayment: closePositionResp.fundingPayment.addD(increasePositionResp.fundingPayment),
                overnightFee: closePositionResp.overnightFee.addD(increasePositionResp.overnightFee),
                exchangedPositionSize: closePositionResp.exchangedPositionSize.addD(
                    increasePositionResp.exchangedPositionSize
                ),
                realizedPnl: closePositionResp.realizedPnl.addD(increasePositionResp.realizedPnl),
                unrealizedPnlAfter: SignedDecimal.zero(),
                marginToVault: closePositionResp.marginToVault.addD(increasePositionResp.marginToVault)
            });
        }
        return positionResp;
    }

    function internalClosePosition(
        IExchange _exchange,
        address _trader,
        Decimal.decimal memory _quoteAssetAmountLimit,
        bool _skipFluctuationCheck
    ) private returns (PositionResp memory positionResp) {
        // check conditions
        Position memory oldPosition = getUnadjustedPosition(_exchange, _trader);
        SignedDecimal.signedDecimal memory oldPositionSize = oldPosition.size;
        requirePositionSize(oldPositionSize);

        (, SignedDecimal.signedDecimal memory unrealizedPnl) =
            getPositionNotionalAndUnrealizedPnl(_exchange, _trader, PnlCalcOption.SPOT_PRICE);

        ISakePerpState.RemainMarginInfo memory remainMarginInfo =
            sakePerpState.calcRemainMarginWithFundingPaymentAndOvernightFee(_exchange, oldPosition, unrealizedPnl);

        positionResp.exchangedPositionSize = oldPositionSize.mulScalar(-1);
        positionResp.realizedPnl = unrealizedPnl;
        positionResp.badDebt = remainMarginInfo.badDebt;
        positionResp.fundingPayment = remainMarginInfo.fundingPayment;
        positionResp.overnightFee = remainMarginInfo.overnightFee;
        positionResp.marginToVault = MixedDecimal.fromDecimal(remainMarginInfo.remainMargin).mulScalar(-1);
        positionResp.exchangedQuoteAssetAmount = _exchange.swapOutput(
            oldPositionSize.toInt() > 0 ? IExchangeTypes.Dir.ADD_TO_AMM : IExchangeTypes.Dir.REMOVE_FROM_AMM,
            oldPositionSize.abs(),
            _quoteAssetAmountLimit,
            _skipFluctuationCheck
        );

        // bankrupt position's bad debt will be also consider as a part of the open interest
        sakePerpState.updateOpenInterestNotional(
            _exchange,
            unrealizedPnl.addD(remainMarginInfo.badDebt).addD(oldPosition.openNotional).mulScalar(-1)
        );
        clearPosition(_exchange, _trader);
    }

    function swapInput(
        IExchange _exchange,
        Side _side,
        Decimal.decimal memory _inputAmount,
        Decimal.decimal memory _minOutputAmount
    ) internal returns (SignedDecimal.signedDecimal memory) {
        IExchangeTypes.Dir dir =
            (_side == Side.BUY) ? IExchangeTypes.Dir.ADD_TO_AMM : IExchangeTypes.Dir.REMOVE_FROM_AMM;
        SignedDecimal.signedDecimal memory outputAmount =
            MixedDecimal.fromDecimal(_exchange.swapInput(dir, _inputAmount, _minOutputAmount));
        if (IExchangeTypes.Dir.REMOVE_FROM_AMM == dir) {
            return outputAmount.mulScalar(-1);
        }
        return outputAmount;
    }

    function transferFee(
        address _from,
        IExchange _exchange,
        Decimal.decimal memory _positionNotional
    ) internal returns (Decimal.decimal memory) {
        Decimal.decimal memory fee = _exchange.calcFee(_positionNotional);
        if (fee.toUint() > 0) {
            address insuranceFundAddress = address(systemSettings.getInsuranceFund(_exchange));
            require(insuranceFundAddress != address(0), "Invalid InsuranceFund");
            Decimal.decimal memory insuranceFundFee = fee.mulD(systemSettings.insuranceFundFeeRatio());
            IERC20Upgradeable(_exchange.quoteAsset()).safeTransferFrom(
                _from,
                address(insuranceFundAddress),
                insuranceFundFee.toUint()
            );
            Decimal.decimal memory lpFee = fee.subD(insuranceFundFee);
            IERC20Upgradeable(_exchange.quoteAsset()).safeTransferFrom(_from, address(sakePerpVault), lpFee.toUint());
            sakePerpVault.addCachedLiquidity(address(_exchange), lpFee);
            return fee;
        }

        return Decimal.zero();
    }

    function withdraw(
        IExchange _exchange,
        address _receiver,
        Decimal.decimal memory _amount
    ) internal {
        return sakePerpVault.withdraw(_exchange, _receiver, _amount);
    }

    function realizeBadDebt(IExchange _exchange, Decimal.decimal memory _badDebt) internal {
        return sakePerpVault.realizeBadDebt(_exchange, _badDebt);
    }

    function transferToInsuranceFund(IExchange _exchange, Decimal.decimal memory _amount) internal {
        IInsuranceFund insuranceFund = systemSettings.getInsuranceFund(_exchange);
        sakePerpVault.withdraw(_exchange, address(insuranceFund), _amount);
    }

    function handleFundingFeeAndOvernightFee(
        IExchange _exchange,
        Decimal.decimal memory _fee,
        Decimal.decimal memory _insuranceFundRatio
    ) internal {
        address insuranceFundAddress = address(systemSettings.getInsuranceFund(_exchange));
        require(insuranceFundAddress != address(0), "Invalid InsuranceFund");
        Decimal.decimal memory insuranceFundFee = _fee.mulD(_insuranceFundRatio);
        sakePerpVault.withdraw(_exchange, insuranceFundAddress, insuranceFundFee);
        Decimal.decimal memory vaultFee = _fee.subD(insuranceFundFee);
        sakePerpVault.addCachedLiquidity(address(_exchange), vaultFee);
    }

    //
    // INTERNAL VIEW FUNCTIONS
    //

    function adjustPositionForLiquidityChanged(IExchange _exchange, address _trader)
        internal
        returns (Position memory)
    {
        Position memory unadjustedPosition = getUnadjustedPosition(_exchange, _trader);
        if (unadjustedPosition.size.toInt() == 0) {
            return unadjustedPosition;
        }
        uint256 latestLiquidityIndex = _exchange.getLiquidityHistoryLength().sub(1);
        if (unadjustedPosition.liquidityHistoryIndex == latestLiquidityIndex) {
            return unadjustedPosition;
        }

        Position memory adjustedPosition =
            sakePerpState.calcPositionAfterLiquidityMigration(_exchange, unadjustedPosition, latestLiquidityIndex);
        SignedDecimal.signedDecimal memory oldAdjustedPosition =
            sakePerpState.calcPositionAfterLiquidityMigrationWithoutNew(
                _exchange,
                unadjustedPosition,
                latestLiquidityIndex
            );
        _exchange.adjustTotalPosition(adjustedPosition.size, oldAdjustedPosition);

        setPosition(_exchange, _trader, adjustedPosition);
        emit PositionAdjusted(
            address(_exchange),
            _trader,
            adjustedPosition.size.toInt(),
            unadjustedPosition.liquidityHistoryIndex,
            adjustedPosition.liquidityHistoryIndex
        );
        return adjustedPosition;
    }

    function getUnadjustedPosition(IExchange _exchange, address _trader)
        public
        view
        override
        returns (Position memory position)
    {
        position = exchangeMap[address(_exchange)].positionMap[_trader];
    }

    //
    // REQUIRE FUNCTIONS
    //
    function requireExchange(IExchange _exchange, bool _open) private view {
        require(systemSettings.isExistedExchange(_exchange), "exchange not found");
        require(_open == _exchange.open(), _open ? "exchange was closed" : "exchange is open");
    }

    function requireNonZeroInput(Decimal.decimal memory _decimal) private pure {
        require(_decimal.toUint() != 0, "input is 0");
    }

    function requirePositionSize(SignedDecimal.signedDecimal memory _size) private pure {
        require(_size.toInt() != 0, "positionSize is 0");
    }

    function requireNotRestrictionMode(IExchange _exchange) private view {
        uint256 currentBlock = _blockNumber();
        if (currentBlock == exchangeMap[address(_exchange)].lastRestrictionBlock) {
            require(
                getUnadjustedPosition(_exchange, msg.sender).blockNumber != currentBlock,
                "only one action allowed"
            );
        }
    }

    function requireMoreMarginRatio(
        SignedDecimal.signedDecimal memory _marginRatio,
        Decimal.decimal memory _baseMarginRatio,
        bool _largerThanOrEqualTo
    ) private pure {
        int256 remainingMarginRatio = _marginRatio.subD(_baseMarginRatio).toInt();
        require(
            _largerThanOrEqualTo ? remainingMarginRatio >= 0 : remainingMarginRatio < 0,
            "Margin ratio not meet criteria"
        );
    }

    //
    // Set System Open Flag
    //
    function pause(bool _pause) public onlyOwner {
        paused = _pause;
    }
}

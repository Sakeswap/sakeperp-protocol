// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interface/IExchangeState.sol";
import "./interface/ISakePerpVault.sol";
import "./types/ISakePerpVaultTypes.sol";
import "./types/IExchangeTypes.sol";
import "./utils/Decimal.sol";
import "./utils/SignedDecimal.sol";
import "./utils/MixedDecimal.sol";
import "./MMLPToken.sol";

contract ExchangeState is IExchangeState, OwnableUpgradeable {
    using SafeMathUpgradeable for uint256;
    using Decimal for Decimal.decimal;
    using SignedDecimal for SignedDecimal.signedDecimal;
    using MixedDecimal for SignedDecimal.signedDecimal;

    event CapChanged(uint256 maxHoldingBaseAsset, uint256 openInterestNotionalCap);
    event InitMarginRatioChanged(uint256 initMarginRatio);
    event MaintenanceMarginRatioChanged(uint256 maintenanceMarginRatio);
    event LiquidationFeeRatioChanged(uint256 liquidationFeeRatio);
    event MaxLiquidationFeeChanged(uint256 maxliquidationFee);

    address public exchange;

    Decimal.decimal private _spreadRatio;
    Decimal.decimal private _maxHoldingBaseAsset;
    Decimal.decimal private _openInterestNotionalCap;
    Decimal.decimal private _initMarginRatio;
    Decimal.decimal private _maintenanceMarginRatio;
    Decimal.decimal private _liquidationFeeRatio;
    Decimal.decimal private _maxLiquidationFee;

    MMLPToken public HighRiskLPToken;
    MMLPToken public LowRiskLPToken;
    Decimal.decimal private _maxOracleSpreadRatio;
    
    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//
    
    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    modifier onlyExchange() {
        require(exchange == _msgSender(), "caller is not exchange");
        _;
    }

    function initialize(
        address _exchange,
        uint256 spreadRatio,
        uint256 initMarginRatio,
        uint256 maintenanceMarginRatio,
        uint256 liquidationFeeRatio,
        uint256 maxLiquidationFee,
        uint256 maxOracleSpreadRatio,
        address systemSettings
    ) public initializer {
        require(
            initMarginRatio != 0 && maintenanceMarginRatio != 0 && liquidationFeeRatio != 0 && maxLiquidationFee != 0,
            "invalid input"
        );
        __Ownable_init();

        exchange = _exchange;
        _spreadRatio = Decimal.decimal(spreadRatio);
        _initMarginRatio = Decimal.decimal(initMarginRatio);
        _maintenanceMarginRatio = Decimal.decimal(maintenanceMarginRatio);
        _liquidationFeeRatio = Decimal.decimal(liquidationFeeRatio);
        _maxLiquidationFee = Decimal.decimal(maxLiquidationFee);
        _maxOracleSpreadRatio = Decimal.decimal(maxOracleSpreadRatio);

        HighRiskLPToken = new MMLPToken("MM High Risk LP Token", "MHT", systemSettings);
        LowRiskLPToken = new MMLPToken("MM Low Risk LP Token", "MLT", systemSettings);
    }

    /**
     * @notice mint MLP for MM
     * @dev only SakePerp can call this function
     */
    function mint(
        ISakePerpVaultTypes.Risk _risk,
        address account,
        uint256 amount
    ) external override onlyExchange {
        if (_risk == ISakePerpVaultTypes.Risk.HIGH) {
            HighRiskLPToken.mint(account, amount);
        } else if (_risk == ISakePerpVaultTypes.Risk.LOW) {
            LowRiskLPToken.mint(account, amount);
        } else {
            revert("invalid risk level");
        }
    }

    /**
     * @notice burn MLP
     * @dev only SakePerp can call this function
     */
    function burn(
        ISakePerpVaultTypes.Risk _risk,
        address account,
        uint256 amount
    ) external override onlyExchange {
        if (_risk == ISakePerpVaultTypes.Risk.HIGH) {
            HighRiskLPToken.burn(account, amount);
        } else if (_risk == ISakePerpVaultTypes.Risk.LOW) {
            LowRiskLPToken.burn(account, amount);
        } else {
            revert("invalid risk level");
        }
    }

    /**
     * @notice calculate spread fee by input quoteAssetAmount
     * @param _quoteAssetAmount quoteAssetAmount
     * @return total tx fee
     */
    function calcFee(Decimal.decimal calldata _quoteAssetAmount)
        external
        view
        override
        returns (Decimal.decimal memory)
    {
        if (_quoteAssetAmount.toUint() == 0) {
            return Decimal.zero();
        }
        return _quoteAssetAmount.mulD(_spreadRatio);
    }

    /*       plus/minus 1 while the amount is not dividable
     *
     *        getInputPrice                         getOutputPrice
     *
     *     ＡＤＤ      (amount - 1)              (amount + 1)   ＲＥＭＯＶＥ
     *      ◥◤            ▲                         |             ◢◣
     *      ◥◤  ------->  |                         ▼  <--------  ◢◣
     *    -------      -------                   -------        -------
     *    |  Q  |      |  B  |                   |  Q  |        |  B  |
     *    -------      -------                   -------        -------
     *      ◥◤  ------->  ▲                         |  <--------  ◢◣
     *      ◥◤            |                         ▼             ◢◣
     *   ＲＥＭＯＶＥ  (amount + 1)              (amount + 1)      ＡＤＤ
     **/

    function getInputPriceWithReserves(
        IExchangeTypes.Dir _dir,
        Decimal.decimal memory _quoteAssetAmount,
        Decimal.decimal memory _quoteAssetPoolAmount,
        Decimal.decimal memory _baseAssetPoolAmount
    ) public pure override returns (Decimal.decimal memory) {
        if (_quoteAssetAmount.toUint() == 0) {
            return Decimal.zero();
        }

        bool isAddToAmm = _dir == IExchangeTypes.Dir.ADD_TO_AMM;
        SignedDecimal.signedDecimal memory invariant =
            MixedDecimal.fromDecimal(_quoteAssetPoolAmount.mulD(_baseAssetPoolAmount));
        SignedDecimal.signedDecimal memory baseAssetAfter;
        Decimal.decimal memory quoteAssetAfter;
        Decimal.decimal memory baseAssetBought;
        if (isAddToAmm) {
            quoteAssetAfter = _quoteAssetPoolAmount.addD(_quoteAssetAmount);
        } else {
            quoteAssetAfter = _quoteAssetPoolAmount.subD(_quoteAssetAmount);
        }
        require(quoteAssetAfter.toUint() != 0, "quote asset after is 0");

        baseAssetAfter = invariant.divD(quoteAssetAfter);
        baseAssetBought = baseAssetAfter.subD(_baseAssetPoolAmount).abs();

        // if the amount is not dividable, return 1 wei less for trader
        if (invariant.abs().modD(quoteAssetAfter).toUint() != 0) {
            if (isAddToAmm) {
                baseAssetBought = baseAssetBought.subD(Decimal.decimal(1));
            } else {
                baseAssetBought = baseAssetBought.addD(Decimal.decimal(1));
            }
        }

        return baseAssetBought;
    }

    function getOutputPriceWithReserves(
        IExchangeTypes.Dir _dir,
        Decimal.decimal memory _baseAssetAmount,
        Decimal.decimal memory _quoteAssetPoolAmount,
        Decimal.decimal memory _baseAssetPoolAmount
    ) public pure override returns (Decimal.decimal memory) {
        if (_baseAssetAmount.toUint() == 0) {
            return Decimal.zero();
        }

        bool isAddToAmm = _dir == IExchangeTypes.Dir.ADD_TO_AMM;
        SignedDecimal.signedDecimal memory invariant =
            MixedDecimal.fromDecimal(_quoteAssetPoolAmount.mulD(_baseAssetPoolAmount));
        SignedDecimal.signedDecimal memory quoteAssetAfter;
        Decimal.decimal memory baseAssetAfter;
        Decimal.decimal memory quoteAssetSold;

        if (isAddToAmm) {
            baseAssetAfter = _baseAssetPoolAmount.addD(_baseAssetAmount);
        } else {
            baseAssetAfter = _baseAssetPoolAmount.subD(_baseAssetAmount);
        }
        require(baseAssetAfter.toUint() != 0, "base asset after is 0");

        quoteAssetAfter = invariant.divD(baseAssetAfter);
        quoteAssetSold = quoteAssetAfter.subD(_quoteAssetPoolAmount).abs();

        // if the amount is not dividable, return 1 wei less for trader
        if (invariant.abs().modD(baseAssetAfter).toUint() != 0) {
            if (isAddToAmm) {
                quoteAssetSold = quoteAssetSold.subD(Decimal.decimal(1));
            } else {
                quoteAssetSold = quoteAssetSold.addD(Decimal.decimal(1));
            }
        }

        return quoteAssetSold;
    }

    /**
     * @notice set new cap during guarded period, which is max position size that traders can hold
     * @dev only owner can call. assume this will be removes soon once the guarded period has ended. must be set before opening exchange
     * @param maxHoldingBaseAsset max position size that traders can hold in 18 digits
     * @param openInterestNotionalCap open interest cap, denominated in quoteToken
     */
    function setCap(Decimal.decimal memory maxHoldingBaseAsset, Decimal.decimal memory openInterestNotionalCap)
        public
        onlyOwner
    {
        _maxHoldingBaseAsset = maxHoldingBaseAsset;
        _openInterestNotionalCap = openInterestNotionalCap;
        emit CapChanged(_maxHoldingBaseAsset.toUint(), _openInterestNotionalCap.toUint());
    }

    /**
     * @notice set init margin ratio
     * @param _ratio new init margin ratio
     */
    function setInitMarginRatio(Decimal.decimal memory _ratio) public onlyOwner {
        require(_ratio.cmp(Decimal.zero()) > 0, "invalid init margin ratio");
        _initMarginRatio = _ratio;
        emit InitMarginRatioChanged(_initMarginRatio.toUint());
    }

    /**
     * @notice set maintenance margin ratio
     * @param _ratio new maintenance margin ratio
     */
    function setMaintenanceMarginRatio(Decimal.decimal memory _ratio) public onlyOwner {
        require(_ratio.cmp(Decimal.zero()) > 0, "invalid maintenance margin ratio");
        _maintenanceMarginRatio = _ratio;
        emit MaintenanceMarginRatioChanged(_maintenanceMarginRatio.toUint());
    }

    /**
     * @notice set liquidation fee ratio
     * @param _ratio new liquidation fee ratio
     */
    function setLiquidationFeeRatio(Decimal.decimal memory _ratio) public onlyOwner {
        require(_ratio.cmp(Decimal.zero()) > 0, "invalid liquidation fee ratio");
        _liquidationFeeRatio = _ratio;
        emit LiquidationFeeRatioChanged(_liquidationFeeRatio.toUint());
    }

    /**
     * @notice set max liquidation Fee
     * @param _fee new max liquidation Fee
     */
    function setMaxLiquidationFee(Decimal.decimal memory _fee) public onlyOwner {
        require(_fee.cmp(Decimal.zero()) > 0, "invalid max liquidation fee");
        _maxLiquidationFee = _fee;
        emit MaxLiquidationFeeChanged(_maxLiquidationFee.toUint());
    }

    /**
     * @notice set new spread ratio
     * @dev only owner can call
     * @param spreadRatio new toll ratio in 18 digits
     */
    function setSpreadRatio(Decimal.decimal memory spreadRatio) public onlyOwner {
        _spreadRatio = spreadRatio;
    }

    /**
     * @notice set new max oracle spread ratio
     * @dev only owner can call
     * @param maxOracleSpreadRatio new toll ratio in 18 digits
     */
    function setMaxOracleSpreadRatio(Decimal.decimal memory maxOracleSpreadRatio) public onlyOwner {
        _maxOracleSpreadRatio = maxOracleSpreadRatio;
    }

    function getMaxHoldingBaseAsset() external view override returns (Decimal.decimal memory) {
        return _maxHoldingBaseAsset;
    }

    function getOpenInterestNotionalCap() external view override returns (Decimal.decimal memory) {
        return _openInterestNotionalCap;
    }

    function initMarginRatio() external view override returns (Decimal.decimal memory) {
        return _initMarginRatio;
    }

    function maintenanceMarginRatio() external view override returns (Decimal.decimal memory) {
        return _maintenanceMarginRatio;
    }

    function liquidationFeeRatio() external view override returns (Decimal.decimal memory) {
        return _liquidationFeeRatio;
    }

    function maxLiquidationFee() external view override returns (Decimal.decimal memory) {
        return _maxLiquidationFee;
    }

    function spreadRatio() external view override returns (Decimal.decimal memory) {
        return _spreadRatio;
    }

    function maxOracleSpreadRatio() external view override returns (Decimal.decimal memory) {
        return _maxOracleSpreadRatio;
    }

    function getLPToken(ISakePerpVaultTypes.Risk _risk) external view override returns (MMLPToken) {
        if (ISakePerpVaultTypes.Risk.HIGH == _risk) {
            return HighRiskLPToken;
        } else {
            return LowRiskLPToken;
        }
    }
}

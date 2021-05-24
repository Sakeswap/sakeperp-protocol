// SPDX-License-Identifier: GPL-3.0-or-later

pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interface/ISakePerpVault.sol";
import "./interface/IInsuranceFund.sol";
import "./interface/ISystemSettings.sol";
import "./interface/IExchange.sol";
import "./interface/IExchangeState.sol";
import "./utils/Decimal.sol";
import "./utils/SignedDecimal.sol";
import "./utils/MixedDecimal.sol";

contract SakePerpVault is ISakePerpVault, OwnableUpgradeable {
    using Decimal for Decimal.decimal;
    using SignedDecimal for SignedDecimal.signedDecimal;
    using MixedDecimal for SignedDecimal.signedDecimal;
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeMathUpgradeable for uint256;

    //
    // EVENTS
    //
    event LiquidityAdd(
        address indexed exchange,
        address indexed account,
        uint256 risk,
        uint256 lpfund,
        uint256 tokenamount
    );
    event LiquidityRemove(
        address indexed exchange,
        address indexed account,
        uint256 risk,
        uint256 lpfund,
        uint256 tokenamount
    );
    //changeType shows the liquidity changed by what
    event LiquidityModify(address indexed exchange, uint256 lpfundHigh, uint256 lpfundLow);
    event BadDebtResolved(
        address indexed exchange,
        uint256 badDebt,
        uint256 insuranceFundResolveBadDebt,
        uint256 mmHighResolveBadDebt,
        uint256 mmLowResolveBadDebt
    );

    struct PoolInfo {
        SignedDecimal.signedDecimal totalLiquidity; // total liquidity of high/low risk pool
        Decimal.decimal totalFund; // fund of MM, not include the fee and pnl
        mapping(address => Decimal.decimal) fund;
        mapping(address => uint256) nextWithdrawTime;
        uint256 maxLoss;
    }

    struct ExchangeInfo {
        mapping(uint256 => PoolInfo) poolInfo; // pool info of high/low risk pool
        Decimal.decimal cachedLiquidity;
        uint256 highRiskLiquidityWeight;
        uint256 lowRiskLiquidityWeight;
    }

    uint256 private constant UINT100 = 100;
    ISystemSettings public systemSettings;
    address public sakePerp;
    uint256 public lpLockTime;

    // exchange info
    mapping(address => ExchangeInfo) public exchangeInfo;

    //**********************************************************//
    //    Can not change the order of above state variables     //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // MODIFIERS
    //
    modifier onlySakePerp() {
        require(_msgSender() == sakePerp, "only sakePerp");
        _;
    }

    //
    // PUBLIC
    //
    function initialize(
        address _sakePerp,
        address _systemSettings,
        uint256 _lockTime
    ) public initializer {
        sakePerp = _sakePerp;
        systemSettings = ISystemSettings(_systemSettings);
        lpLockTime = _lockTime;
        __Ownable_init();
    }

    /**
     * @notice set SakePerp dependency
     * @dev only owner can call
     * @param _sakePerp address
     */
    function setSakePerp(address _sakePerp) external onlyOwner {
        require(_sakePerp != address(0), "empty address");
        sakePerp = _sakePerp;
    }

    /**
     * @notice set systemSettings dependency
     * @dev only owner can call
     * @param _systemSettings address
     */
    function setSystemSettings(address _systemSettings) external onlyOwner {
        require(_systemSettings != address(0), "empty address");
        systemSettings = ISystemSettings(_systemSettings);
    }

    /**
     * @notice set high risk liquidity provider token weight
     * @dev only owner can call
     * @param _exchange address
     * @param _highWeight high risk pool lp token weight
     * @param _lowWeight low risk pool lp token weight
     */
    function setRiskLiquidityWeight(
        address _exchange,
        uint256 _highWeight,
        uint256 _lowWeight
    ) public override {
        require(_msgSender() == owner() || _msgSender() == _exchange, "invalid caller");
        require(_highWeight.add(_lowWeight) > 0, "invalid weight");
        exchangeInfo[_exchange].highRiskLiquidityWeight = _highWeight;
        exchangeInfo[_exchange].lowRiskLiquidityWeight = _lowWeight;
    }

    /**
     * @notice set pool max loss
     * @dev only owner can call
     * @param _exchange exchange address
     * @param _risk pool type
     * @param _max max loss
     */
    function setMaxLoss(
        address _exchange,
        Risk _risk,
        uint256 _max
    ) public override {
        require(_msgSender() == owner() || _msgSender() == _exchange, "invalid caller");
        require(_max > 0 && _max <= UINT100, "invalid max loss value");
        PoolInfo storage poolInfo = exchangeInfo[_exchange].poolInfo[uint256(_risk)];
        SignedDecimal.signedDecimal memory lpUnrealizedPNL = getLpUnrealizedPNL(_exchange, _risk);
        Decimal.decimal memory lockedLiquidity = poolInfo.totalFund.mulScalar(UINT100 - _max).divScalar(UINT100);
        require(!poolInfo.totalLiquidity.subD(lockedLiquidity).addD(lpUnrealizedPNL).isNegative(), "fund not enough");
        poolInfo.maxLoss = _max;
    }

    /**
     * @notice set lp liquidity lock time
     * @dev only owner can call
     * @param _lockTime new lock time
     */
    function setLpLockTime(uint256 _lockTime) external onlyOwner {
        lpLockTime = _lockTime;
    }

    /**
     * @notice withdraw token to trader/liquidator
     * @dev only SakePerp can call
     * @param _exchange exchange address
     * @param _receiver receiver, could be trader or liquidator
     * @param _amount token amount
     */
    function withdraw(
        IExchange _exchange,
        address _receiver,
        Decimal.decimal memory _amount
    ) public override onlySakePerp {
        _withdraw(_exchange, _receiver, _amount);
    }

    function _withdraw(
        IExchange _exchange,
        address _receiver,
        Decimal.decimal memory _amount
    ) internal {
        IERC20Upgradeable _token = _exchange.quoteAsset();
        Decimal.decimal memory totalTokenBalance = Decimal.decimal(_token.balanceOf(address(this)));
        if (totalTokenBalance.toUint() < _amount.toUint()) {
            Decimal.decimal memory balanceShortage = _amount.subD(totalTokenBalance);
            IInsuranceFund insuranceFund = systemSettings.getInsuranceFund(_exchange);
            Decimal.decimal memory totalInsurceFund = Decimal.decimal(_token.balanceOf(address(insuranceFund)));
            require(totalInsurceFund.toUint() >= balanceShortage.toUint(), "Fund not enough");
            insuranceFund.withdraw(balanceShortage);
        }

        _token.safeTransfer(_receiver, _amount.toUint());
    }

    function _realizeMMBadDebt(address _exchange, Decimal.decimal memory _badDebt)
        internal
        returns (Decimal.decimal memory, Decimal.decimal memory)
    {
        Decimal.decimal memory mmHighResolveBadDebt = Decimal.zero();
        Decimal.decimal memory mmLowResolveBadDebt = Decimal.zero();

        (SignedDecimal.signedDecimal memory highAvailable, SignedDecimal.signedDecimal memory lowAvailable) =
            getAllMMAvailableLiquidityWithPNL(_exchange);
        require(highAvailable.addD(lowAvailable).subD(_badDebt).toInt() >= 0, "MM Bankrupt");

        (Decimal.decimal memory highFactor, Decimal.decimal memory lowFactor) = _getMMFactor(_exchange);
        mmHighResolveBadDebt = _badDebt.mulD(highFactor).divD(highFactor.addD(lowFactor));
        mmLowResolveBadDebt = _badDebt.subD(mmHighResolveBadDebt);

        SignedDecimal.signedDecimal memory highRemainLiquidity = highAvailable.subD(mmHighResolveBadDebt);
        SignedDecimal.signedDecimal memory lowRemainLiquidity = lowAvailable.subD(mmLowResolveBadDebt);
        if (highRemainLiquidity.isNegative()) {
            mmHighResolveBadDebt = highAvailable.abs();
            mmLowResolveBadDebt = _badDebt.subD(mmHighResolveBadDebt);
        } else if (lowRemainLiquidity.isNegative()) {
            mmLowResolveBadDebt = lowAvailable.abs();
            mmHighResolveBadDebt = _badDebt.subD(mmLowResolveBadDebt);
        }

        PoolInfo storage highPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.HIGH)];
        PoolInfo storage lowPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.LOW)];
        highPool.totalLiquidity = highPool.totalLiquidity.subD(mmHighResolveBadDebt);
        lowPool.totalLiquidity = lowPool.totalLiquidity.subD(mmLowResolveBadDebt);

        return (mmHighResolveBadDebt, mmLowResolveBadDebt);
    }

    /**
     * @notice realize bad debt. insurance fund will pay first, lp fund will pay the rest
     * @dev only SakePerp can call
     * @param _exchange IExchange address
     * @param _badDebt amount of the bad debt
     */
    function realizeBadDebt(IExchange _exchange, Decimal.decimal memory _badDebt) external override onlySakePerp {
        // in order to realize all the bad debt vault need extra tokens from insuranceFund
        IInsuranceFund insuranceFund = systemSettings.getInsuranceFund(_exchange);
        Decimal.decimal memory totalInsuranceFund =
            Decimal.decimal(_exchange.quoteAsset().balanceOf(address(insuranceFund)));
        Decimal.decimal memory mmResolveBadDebt = Decimal.zero();
        Decimal.decimal memory insuranceFundResolveBadDebt = Decimal.zero();
        Decimal.decimal memory mmHighResolveBadDebt = Decimal.zero();
        Decimal.decimal memory mmLowResolveBadDebt = Decimal.zero();

        if (totalInsuranceFund.toUint() >= _badDebt.toUint()) {
            insuranceFund.withdraw(_badDebt);
            insuranceFundResolveBadDebt = _badDebt;
            mmResolveBadDebt = Decimal.zero();
        } else {
            insuranceFund.withdraw(totalInsuranceFund);
            insuranceFundResolveBadDebt = totalInsuranceFund;
            mmResolveBadDebt = _badDebt.subD(totalInsuranceFund);
        }

        if (mmResolveBadDebt.toUint() > 0) {
            (mmHighResolveBadDebt, mmLowResolveBadDebt) = _realizeMMBadDebt(address(_exchange), mmResolveBadDebt);
        }

        emit BadDebtResolved(
            address(_exchange),
            _badDebt.toUint(),
            insuranceFundResolveBadDebt.toUint(),
            mmHighResolveBadDebt.toUint(),
            mmLowResolveBadDebt.toUint()
        );
    }

    /**
     * @notice add cached liquidity to mm's total liquidity
     */
    function modifyLiquidity() external override {
        address _exchange = _msgSender();
        require(systemSettings.isExistedExchange(IExchange(_exchange)), "exchange not found");
        (Decimal.decimal memory highFactor, Decimal.decimal memory lowFactor) = _getMMFactor(_exchange);
        ExchangeInfo storage _exchangeInfo = exchangeInfo[_exchange];
        PoolInfo storage highPool = _exchangeInfo.poolInfo[uint256(Risk.HIGH)];
        PoolInfo storage lowPool = _exchangeInfo.poolInfo[uint256(Risk.LOW)];
        Decimal.decimal memory cachedLiquidity = _exchangeInfo.cachedLiquidity;
        Decimal.decimal memory cachedForHigh = cachedLiquidity.mulD(highFactor).divD(highFactor.addD(lowFactor));
        Decimal.decimal memory cachedForLow = cachedLiquidity.subD(cachedForHigh);
        highPool.totalLiquidity = highPool.totalLiquidity.addD(cachedForHigh);
        lowPool.totalLiquidity = lowPool.totalLiquidity.addD(cachedForLow);
        _exchangeInfo.cachedLiquidity = Decimal.zero();
        emit LiquidityModify(_exchange, cachedForHigh.toUint(), cachedForLow.toUint());
    }

    /**
     * @notice addCachedLiquidity (trader fee, overnight fee, trading spread)
     * @param _exchange exchange address
     * @param _DeltaLpLiquidity liquidity amount to be added
     */
    function addCachedLiquidity(address _exchange, Decimal.decimal memory _DeltaLpLiquidity)
        public
        override
        onlySakePerp
    {
        ExchangeInfo storage _exchangeInfo = exchangeInfo[_exchange];
        _exchangeInfo.cachedLiquidity = _exchangeInfo.cachedLiquidity.addD(_DeltaLpLiquidity);
    }

    /**
     * @notice addLiquidity to Exchange
     * @param _exchange IExchange address
     * @param _risk pool type
     * @param _quoteAssetAmount quote asset amount in 18 digits. Can Not be 0
     */
    function addLiquidity(
        IExchange _exchange,
        Risk _risk,
        Decimal.decimal memory _quoteAssetAmount
    ) external {
        requireExchange(_exchange, true);
        requireNonZeroInput(_quoteAssetAmount);

        address sender = _msgSender();
        _exchange.quoteAsset().safeTransferFrom(sender, address(this), _quoteAssetAmount.toUint());

        PoolInfo storage poolInfo = exchangeInfo[address(_exchange)].poolInfo[uint256(_risk)];
        SignedDecimal.signedDecimal memory lpUnrealizedPNL = getLpUnrealizedPNL(address(_exchange), _risk);

        Decimal.decimal memory totalLpTokenAmount =
            Decimal.decimal(IExchangeState(_exchange.getExchangeState()).getLPToken(_risk).totalSupply());
        if (totalLpTokenAmount.toUint() > 0) {
            _requireMMNotBankrupt(address(_exchange), _risk);
        }

        SignedDecimal.signedDecimal memory returnLpAmount = SignedDecimal.zero();
        if (totalLpTokenAmount.toUint() == 0) {
            returnLpAmount = MixedDecimal.fromDecimal(_quoteAssetAmount);
        } else {
            returnLpAmount = MixedDecimal.fromDecimal(_quoteAssetAmount).mulD(totalLpTokenAmount).divD(
                poolInfo.totalLiquidity.addD(lpUnrealizedPNL)
            );
        }

        if (poolInfo.fund[sender].toUint() == 0) {
            poolInfo.nextWithdrawTime[sender] = block.timestamp.add(lpLockTime);
        }

        poolInfo.totalLiquidity = poolInfo.totalLiquidity.addD(_quoteAssetAmount);
        poolInfo.totalFund = poolInfo.totalFund.addD(_quoteAssetAmount);
        poolInfo.fund[sender] = poolInfo.fund[sender].addD(_quoteAssetAmount);
        _exchange.mint(_risk, sender, returnLpAmount.toUint());

        emit LiquidityAdd(
            address(_exchange),
            sender,
            uint256(_risk),
            _quoteAssetAmount.toUint(),
            returnLpAmount.toUint()
        );
    }

    /**
     * @notice remove Liquidity from Exchange
     * @param _exchange IExchange address
     * @param _risk pool type
     * @param _lpTokenAmount lp token asset amount in 18 digits. Can Not be 0
     */
    function removeLiquidity(
        IExchange _exchange,
        Risk _risk,
        Decimal.decimal memory _lpTokenAmount
    ) external {
        PoolInfo storage poolInfo = exchangeInfo[address(_exchange)].poolInfo[uint256(_risk)];

        address sender = _msgSender();
        require(block.timestamp >= poolInfo.nextWithdrawTime[sender], "liquidity locked");
        requireExchange(_exchange, true);
        requireNonZeroInput(_lpTokenAmount);
        _requireMMNotBankrupt(address(_exchange), _risk);

        MMLPToken lpToken = IExchangeState(_exchange.getExchangeState()).getLPToken(_risk);
        SignedDecimal.signedDecimal memory lpUnrealizedPNL = getLpUnrealizedPNL(address(_exchange), _risk);
        Decimal.decimal memory totalLpTokenAmount = Decimal.decimal(lpToken.totalSupply());
        Decimal.decimal memory traderLpTokenAmount = Decimal.decimal(lpToken.balanceOf(sender));
        Decimal.decimal memory removeFund = poolInfo.fund[sender].mulD(_lpTokenAmount).divD(traderLpTokenAmount);
        SignedDecimal.signedDecimal memory returnAmount =
            poolInfo.totalLiquidity.addD(lpUnrealizedPNL).mulD(_lpTokenAmount).divD(totalLpTokenAmount).mulD(
                Decimal.one().subD(systemSettings.lpWithdrawFeeRatio())
            );

        poolInfo.totalLiquidity = poolInfo.totalLiquidity.subD(returnAmount);
        poolInfo.totalFund = poolInfo.totalFund.subD(removeFund);
        poolInfo.fund[sender] = poolInfo.fund[sender].subD(removeFund);

        poolInfo.nextWithdrawTime[sender] = block.timestamp.add(lpLockTime);
        _exchange.burn(_risk, sender, _lpTokenAmount.toUint());
        _withdraw(_exchange, sender, returnAmount.abs());

        emit LiquidityRemove(
            address(_exchange),
            sender,
            uint256(_risk),
            returnAmount.toUint(),
            _lpTokenAmount.toUint()
        );
    }

    /**
     * @notice remove Liquidity from Exchange when shutdown
     * @param _exchange IExchange address
     * @param _risk pool type
     */
    function removeLiquidityWhenShutdown(IExchange _exchange, Risk _risk) external {
        address sender = _msgSender();
        requireExchange(_exchange, false);

        PoolInfo storage poolInfo = exchangeInfo[address(_exchange)].poolInfo[uint256(_risk)];
        SignedDecimal.signedDecimal memory lpUnrealizedPNL = getLpUnrealizedPNL(address(_exchange), _risk);
        SignedDecimal.signedDecimal memory remainAmount = poolInfo.totalLiquidity.addD(lpUnrealizedPNL);
        if (remainAmount.toInt() > 0) {
            MMLPToken lpToken = IExchangeState(_exchange.getExchangeState()).getLPToken(_risk);
            Decimal.decimal memory _lpTokenAmount = Decimal.decimal(lpToken.balanceOf(sender));
            Decimal.decimal memory totalLpTokenAmount = Decimal.decimal(lpToken.totalSupply());
            Decimal.decimal memory removeFund = poolInfo.fund[sender];
            SignedDecimal.signedDecimal memory returnAmount =
                remainAmount.mulD(_lpTokenAmount).divD(totalLpTokenAmount);

            poolInfo.totalLiquidity = poolInfo.totalLiquidity.subD(returnAmount);
            poolInfo.totalFund = poolInfo.totalFund.subD(removeFund);
            poolInfo.fund[sender] = Decimal.zero();

            _exchange.burn(_risk, sender, _lpTokenAmount.toUint());
            _withdraw(_exchange, sender, returnAmount.abs());

            emit LiquidityRemove(
                address(_exchange),
                sender,
                uint256(_risk),
                returnAmount.toUint(),
                _lpTokenAmount.toUint()
            );
        }
    }

    //
    // VIEW FUNCTIONS
    //
    function getTotalLpUnrealizedPNL(IExchange _exchange)
        public
        view
        override
        returns (SignedDecimal.signedDecimal memory)
    {
        (Decimal.decimal memory _quoteAssetReserve, Decimal.decimal memory _baseAssetReserve) = _exchange.getReserve();
        return _exchange.getMMUnrealizedPNL(_baseAssetReserve, _quoteAssetReserve);
    }

    function getAllLpUnrealizedPNL(address _exchange)
        public
        view
        returns (SignedDecimal.signedDecimal memory, SignedDecimal.signedDecimal memory)
    {
        SignedDecimal.signedDecimal memory totalLpUnrealizedPNL = getTotalLpUnrealizedPNL(IExchange(_exchange));
        (Decimal.decimal memory highFactor, Decimal.decimal memory lowFactor) = _getMMFactor(_exchange);
        if (totalLpUnrealizedPNL.toInt() == 0) {
            return (SignedDecimal.zero(), SignedDecimal.zero());
        }

        SignedDecimal.signedDecimal memory highUnrealizedPNL =
            totalLpUnrealizedPNL.mulD(highFactor).divD(highFactor.addD(lowFactor));
        SignedDecimal.signedDecimal memory lowUnrealizedPNL = totalLpUnrealizedPNL.subD(highUnrealizedPNL);

        {
            (SignedDecimal.signedDecimal memory highAvailable, SignedDecimal.signedDecimal memory lowAvailable) =
                getAllMMAvailableLiquidity(_exchange);
            SignedDecimal.signedDecimal memory highTotalLiquidity = highAvailable.addD(highUnrealizedPNL);
            SignedDecimal.signedDecimal memory lowTotalLiquidity = lowAvailable.addD(lowUnrealizedPNL);
            if (highTotalLiquidity.isNegative()) {
                highUnrealizedPNL = highAvailable.mulScalar(-1);
                lowUnrealizedPNL = totalLpUnrealizedPNL.subD(highUnrealizedPNL);
            } else if (lowTotalLiquidity.isNegative()) {
                lowUnrealizedPNL = lowAvailable.mulScalar(-1);
                highUnrealizedPNL = totalLpUnrealizedPNL.subD(lowUnrealizedPNL);
            }
        }

        return (highUnrealizedPNL, lowUnrealizedPNL);
    }

    function getLpUnrealizedPNL(address _exchange, Risk _risk)
        public
        view
        returns (SignedDecimal.signedDecimal memory)
    {
        (SignedDecimal.signedDecimal memory high, SignedDecimal.signedDecimal memory low) =
            getAllLpUnrealizedPNL(_exchange);
        return _risk == Risk.HIGH ? high : low;
    }

    function getLpLiquidityAndUnrealizedPNL(address _exchange, Risk _risk)
        public
        view
        returns (SignedDecimal.signedDecimal memory, SignedDecimal.signedDecimal memory)
    {
        (SignedDecimal.signedDecimal memory highLiquidity, SignedDecimal.signedDecimal memory lowLiquidity) =
            getAllMMLiquidity(_exchange);
        (SignedDecimal.signedDecimal memory highUnrealizedPNL, SignedDecimal.signedDecimal memory lowUnrealizedPNL) =
            getAllLpUnrealizedPNL(_exchange);

        if (Risk.HIGH == _risk) {
            return (highLiquidity, highUnrealizedPNL);
        } else {
            return (lowLiquidity, lowUnrealizedPNL);
        }
    }

    function getLpTokenPrice(IExchange _exchange, Risk _risk)
        public
        view
        returns (int256 tokenPrice, int256 tokenPriceWithFee)
    {
        (SignedDecimal.signedDecimal memory lpLiquidity, SignedDecimal.signedDecimal memory lpUnrealizedPNL) =
            getLpLiquidityAndUnrealizedPNL(address(_exchange), _risk);

        Decimal.decimal memory totalLpTokenAmount =
            Decimal.decimal(IExchangeState(_exchange.getExchangeState()).getLPToken(_risk).totalSupply());
        if (totalLpTokenAmount.toUint() == 0) {
            tokenPriceWithFee = int256(Decimal.one().toUint());
            tokenPrice = int256(Decimal.one().toUint());
        } else {
            SignedDecimal.signedDecimal memory lpLiquidityWithFee =
                lpLiquidity.addD(getMMCachedLiquidity(address(_exchange), _risk));
            tokenPriceWithFee = lpUnrealizedPNL.addD(lpLiquidityWithFee).divD(totalLpTokenAmount).toInt();
            tokenPrice = lpUnrealizedPNL.addD(lpLiquidity).divD(totalLpTokenAmount).toInt();
        }
    }

    function getMMLiquidity(address _exchange, Risk _risk)
        public
        view
        override
        returns (SignedDecimal.signedDecimal memory)
    {
        return exchangeInfo[_exchange].poolInfo[uint256(_risk)].totalLiquidity;
    }

    function getAllMMLiquidity(address _exchange)
        public
        view
        override
        returns (SignedDecimal.signedDecimal memory, SignedDecimal.signedDecimal memory)
    {
        PoolInfo memory highPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.HIGH)];
        PoolInfo memory lowPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.LOW)];
        return (highPool.totalLiquidity, lowPool.totalLiquidity);
    }

    function getAllMMAvailableLiquidity(address _exchange)
        public
        view
        returns (SignedDecimal.signedDecimal memory, SignedDecimal.signedDecimal memory)
    {
        PoolInfo memory highPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.HIGH)];
        PoolInfo memory lowPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.LOW)];
        Decimal.decimal memory highLockedLiquidity =
            highPool.totalFund.mulScalar(UINT100 - highPool.maxLoss).divScalar(UINT100);
        Decimal.decimal memory lowLockedLiquidity =
            lowPool.totalFund.mulScalar(UINT100 - lowPool.maxLoss).divScalar(UINT100);
        SignedDecimal.signedDecimal memory highAvailable = highPool.totalLiquidity.subD(highLockedLiquidity);
        SignedDecimal.signedDecimal memory lowAvailable = lowPool.totalLiquidity.subD(lowLockedLiquidity);
        return (highAvailable, lowAvailable);
    }

    function getAllMMAvailableLiquidityWithPNL(address _exchange)
        public
        view
        returns (SignedDecimal.signedDecimal memory, SignedDecimal.signedDecimal memory)
    {
        (SignedDecimal.signedDecimal memory highAvailable, SignedDecimal.signedDecimal memory lowAvailable) =
            getAllMMAvailableLiquidity(_exchange);
        (SignedDecimal.signedDecimal memory highUnrealizedPNL, SignedDecimal.signedDecimal memory lowUnrealizedPNL) =
            getAllLpUnrealizedPNL(_exchange);
        return (highAvailable.addD(highUnrealizedPNL), lowAvailable.addD(lowUnrealizedPNL));
    }

    function getTotalMMLiquidity(address _exchange) public view override returns (SignedDecimal.signedDecimal memory) {
        PoolInfo memory highPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.HIGH)];
        PoolInfo memory lowPool = exchangeInfo[_exchange].poolInfo[uint256(Risk.LOW)];
        return highPool.totalLiquidity.addD(lowPool.totalLiquidity);
    }

    function getTotalMMAvailableLiquidity(address _exchange)
        public
        view
        override
        returns (SignedDecimal.signedDecimal memory)
    {
        (SignedDecimal.signedDecimal memory high, SignedDecimal.signedDecimal memory low) =
            getAllMMAvailableLiquidity(_exchange);
        return high.addD(low);
    }

    function getMMCachedLiquidity(address _exchange, Risk _risk) public view override returns (Decimal.decimal memory) {
        Decimal.decimal memory cachedLiquidity = exchangeInfo[_exchange].cachedLiquidity;
        (Decimal.decimal memory highFactor, Decimal.decimal memory lowFactor) = _getMMFactor(_exchange);
        Decimal.decimal memory cachedForHigh = cachedLiquidity.mulD(highFactor).divD(highFactor.addD(lowFactor));
        Decimal.decimal memory cachedForLow = cachedLiquidity.subD(cachedForHigh);
        return Risk.HIGH == _risk ? cachedForHigh : cachedForLow;
    }

    function getTotalMMCachedLiquidity(address _exchange) public view override returns (Decimal.decimal memory) {
        return exchangeInfo[_exchange].cachedLiquidity;
    }

    function _getMMFactor(address _exchange) internal view returns (Decimal.decimal memory, Decimal.decimal memory) {
        ExchangeInfo memory _exchangeInfo = exchangeInfo[_exchange];
        return (
            Decimal.decimal(_exchangeInfo.highRiskLiquidityWeight),
            Decimal.decimal(_exchangeInfo.lowRiskLiquidityWeight)
        );
    }

    function getMaxLoss(address _exchange) public view returns (uint256, uint256) {
        return (
            exchangeInfo[_exchange].poolInfo[uint256(Risk.HIGH)].maxLoss,
            exchangeInfo[_exchange].poolInfo[uint256(Risk.LOW)].maxLoss
        );
    }

    function getPoolWeight(address _exchange) public view returns (uint256, uint256) {
        return (exchangeInfo[_exchange].highRiskLiquidityWeight, exchangeInfo[_exchange].lowRiskLiquidityWeight);
    }

    function getLockedLiquidity(
        address _exchange,
        Risk _risk,
        address _mm
    ) public view returns (Decimal.decimal memory) {
        PoolInfo storage poolInfo = exchangeInfo[_exchange].poolInfo[uint256(_risk)];
        return poolInfo.fund[_mm].mulScalar(UINT100 - poolInfo.maxLoss).divScalar(UINT100);
    }

    function getTotalFund(address _exchange, Risk _risk) public view returns (Decimal.decimal memory) {
        return exchangeInfo[_exchange].poolInfo[uint256(_risk)].totalFund;
    }

    function getFund(
        address _exchange,
        Risk _risk,
        address _mm
    ) public view returns (Decimal.decimal memory) {
        return exchangeInfo[_exchange].poolInfo[uint256(_risk)].fund[_mm];
    }

    function getNextWidhdrawTime(
        address _exchange,
        Risk _risk,
        address _mm
    ) public view returns (uint256) {
        return exchangeInfo[_exchange].poolInfo[uint256(_risk)].nextWithdrawTime[_mm];
    }

    //
    // REQUIRE FUNCTIONS
    //
    function requireMMNotBankrupt(address _exchange) public override {
        SignedDecimal.signedDecimal memory totalLpUnrealizedPNL = getTotalLpUnrealizedPNL(IExchange(_exchange));
        (SignedDecimal.signedDecimal memory highLiquidity, SignedDecimal.signedDecimal memory lowLiquidity) =
            getAllMMLiquidity(_exchange);
        require(totalLpUnrealizedPNL.addD(highLiquidity).addD(lowLiquidity).toInt() > 0, "MM Bankrupt");
    }

    function _requireMMNotBankrupt(address _exchange, Risk _risk) internal view {
        (SignedDecimal.signedDecimal memory lpLiquidity, SignedDecimal.signedDecimal memory lpUnrealizedPNL) =
            getLpLiquidityAndUnrealizedPNL(_exchange, _risk);
        require(lpUnrealizedPNL.addD(lpLiquidity).toInt() >= 0, "MM Bankrupt");
    }

    function requireNonZeroInput(Decimal.decimal memory _decimal) private pure {
        require(_decimal.toUint() != 0, "input is 0");
    }

    function requireExchange(IExchange _exchange, bool _open) private view {
        require(systemSettings.isExistedExchange(_exchange), "exchange not found");
        require(_open == _exchange.open(), _open ? "exchange was closed" : "exchange is open");
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

// Inheritance
import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interface/ISystemSettings.sol";
import "./interface/IExchange.sol";
import "./interface/IInsuranceFund.sol";
// Libraries
import "./utils/Decimal.sol";

contract SystemSettings is OwnableUpgradeable, ISystemSettings {
    using Decimal for Decimal.decimal;
    using SafeMathUpgradeable for uint256;

    //
    // EVENTS
    //
    event InsuranceFundFeeRatioChanged(uint256 insuranceFundFeeRatio);
    event LpWithdrawFeeRatioChanged(uint256 lpWithdrawFeeRatio);
    event OvernightFeeRatioChanged(uint256 overnightFeeRatio);
    event OvernightFeeLpShareRatioChanged(uint256 overnightFeeLpShareRatio);
    event FundingFeeLpShareRatioChanged(uint256 fundingFeeLpShareRatio);
    event OvernightFeePeriodChanged(uint256 overnightFeePeriod);
    event ExchangeAdded(address exchange, address insuranceFund);
    event ExchangeRemoved(address exchange);

    // only admin
    Decimal.decimal private _insuranceFundFeeRatio;

    // only admin
    Decimal.decimal private _lpWithdrawFeeRatio;

    // only admin
    Decimal.decimal private _overnightFeeRatio;

    // only admin
    Decimal.decimal private _overnightFeeLpShareRatio;

    // only admin
    Decimal.decimal private _fundingFeeLpShareRatio;

    // only admin
    bool public _paused;

    struct ExchangeMap {
        IInsuranceFund insuranceFund;
        bool existed;
        uint256 _nextOvernightFeeTime;
    }

    mapping(address => ExchangeMap) private exchangeMap;
    IExchange[] private exchanges;

    //only admin
    uint256 private _overnightFeePeriod;
    address public _sakePerp;

    bool public blockTransfer; // if block lp token transfer
    mapping(address => bool) public transferWhitelist;
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
        require(msg.sender == _sakePerp, "only sakePerp");
        _;
    }

    //
    // External
    //
    function initialize(
        address sakePerp,
        uint256 insuranceFundFeeRatio,
        uint256 lpWithdrawFeeRatio,
        uint256 overnightFeeRatio,
        uint256 overnightFeeLpShareRatio,
        uint256 fundingFeeLpShareRatio,
        uint256 overnightFeePeriod
    ) public initializer {
        __Ownable_init();

        _sakePerp = sakePerp;
        _insuranceFundFeeRatio = Decimal.decimal(insuranceFundFeeRatio);
        _lpWithdrawFeeRatio = Decimal.decimal(lpWithdrawFeeRatio);
        _overnightFeeRatio = Decimal.decimal(overnightFeeRatio);
        _overnightFeeLpShareRatio = Decimal.decimal(overnightFeeLpShareRatio);
        _fundingFeeLpShareRatio = Decimal.decimal(fundingFeeLpShareRatio);
        _overnightFeePeriod = overnightFeePeriod;
        blockTransfer = true;
    }

    /**
     * @notice set SakePerp dependency
     * @dev only owner can call
     * @param sakePerp address
     */

    function setSakePerp(address sakePerp) external onlyOwner {
        require(sakePerp != address(0), "empty address");
        _sakePerp = sakePerp;
    }

    /**
     * @notice set insurancefund fee  ratio
     * @dev only owner can call
     * @param insuranceFundFeeRatio new insurance fund ratio in 18 digits
     */
    function setInsuranceFundFeeRatio(Decimal.decimal memory insuranceFundFeeRatio) public onlyOwner {
        _insuranceFundFeeRatio = insuranceFundFeeRatio;
        emit InsuranceFundFeeRatioChanged(_insuranceFundFeeRatio.toUint());
    }

    /**
     * @notice set lpwithdraw fee  ratio
     * @dev only owner can call
     * @param lpWithdrawFeeRatio new lp withdraw fee ratio in 18 digits
     */
    function setLpWithdrawFeeRatio(Decimal.decimal memory lpWithdrawFeeRatio) public onlyOwner {
        _lpWithdrawFeeRatio = lpWithdrawFeeRatio;
        emit LpWithdrawFeeRatioChanged(_lpWithdrawFeeRatio.toUint());
    }

    /**
     * @notice set overnight fee ratio
     * @dev only owner can call
     * @param overnightFeeRatio new overnight fee ratio in 18 digits
     */
    function setOvernightFeeRatio(Decimal.decimal memory overnightFeeRatio) public onlyOwner {
        _overnightFeeRatio = overnightFeeRatio;
        emit OvernightFeeRatioChanged(_overnightFeeRatio.toUint());
    }

    /**
     * @notice set overnight fee period
     * @dev only owner can call
     * @param overnightFeePeriod new overnight fee period
     */
    function setOvernightFeePeriod(uint256 overnightFeePeriod) public onlyOwner {
        _overnightFeePeriod = overnightFeePeriod;
        emit OvernightFeeLpShareRatioChanged(_overnightFeeLpShareRatio.toUint());
    }

    /**
     * @notice set overnight fee lp share ratio
     * @dev only owner can call
     * @param overnightFeeLpShareRatio new overnight fee ratio in 18 digits
     */
    function setOvernightFeeLpShareRatio(Decimal.decimal memory overnightFeeLpShareRatio) public onlyOwner {
        _overnightFeeLpShareRatio = overnightFeeLpShareRatio;
        emit OvernightFeeLpShareRatioChanged(_overnightFeeLpShareRatio.toUint());
    }

    /**
     * @notice set
     * @dev only owner can call
     * @param fundingFeeLpShareRatio new funding fee lp share ratio in 18 digits
     */
    function setFundingFeeLpShareRatio(Decimal.decimal memory fundingFeeLpShareRatio) public onlyOwner {
        _fundingFeeLpShareRatio = fundingFeeLpShareRatio;
        emit FundingFeeLpShareRatioChanged(_fundingFeeLpShareRatio.toUint());
    }

    /**
     * @notice set next overnight fee time
     * @param _exchange exchange address
     */
    function setNextOvernightFeeTime(IExchange _exchange) public override onlySakePerp {
        require(
            _blockTimestamp() >= exchangeMap[address(_exchange)]._nextOvernightFeeTime,
            "pay overnight fee too early"
        );

        uint256 fundingPeriod = _overnightFeePeriod;
        uint256 fundingBufferPeriod = fundingPeriod.div(2);

        // in order to prevent multiple funding settlement during very short time after network congestion
        uint256 minNextValidOvernightFeeTime = _blockTimestamp().add(fundingBufferPeriod);

        // floor((nextFundingTime + fundingPeriod) / 3600) * 3600
        uint256 nextOvernightFeeTimeOnHourStart =
            exchangeMap[address(_exchange)]._nextOvernightFeeTime.add(fundingPeriod).div(1 hours).mul(1 hours);

        // max(nextFundingTimeOnHourStart, minNextValidFundingTime)
        exchangeMap[address(_exchange)]._nextOvernightFeeTime = nextOvernightFeeTimeOnHourStart >
            minNextValidOvernightFeeTime
            ? nextOvernightFeeTimeOnHourStart
            : minNextValidOvernightFeeTime;
    }

    /**
     * @dev only owner can call
     * @param _exchange IExchange address
     */
    function addExchange(IExchange _exchange, IInsuranceFund _insuranceFund) public onlyOwner {
        require(!isExistedExchange(_exchange), "exchange already added");
        exchangeMap[address(_exchange)].existed = true;
        exchangeMap[address(_exchange)].insuranceFund = _insuranceFund;
        exchanges.push(_exchange);

        exchangeMap[address(_exchange)]._nextOvernightFeeTime = _blockTimestamp()
            .add(_overnightFeePeriod)
            .div(1 hours)
            .mul(1 hours);

        emit ExchangeAdded(address(_exchange), address(_insuranceFund));
    }

    /**
     * @dev only owner can call. no need to call
     * @param _exchange IExchange address
     */
    function removeExchange(IExchange _exchange) external onlyOwner {
        require(isExistedExchange(_exchange), "amm not existed");
        exchangeMap[address(_exchange)].existed = false;
        exchangeMap[address(_exchange)].insuranceFund = IInsuranceFund(address(0));
        uint256 exchangeLength = exchanges.length;
        for (uint256 i = 0; i < exchangeLength; i++) {
            if (exchanges[i] == _exchange) {
                exchanges[i] = exchanges[exchangeLength - 1];
                exchanges.pop();
                break;
            }
        }
        emit ExchangeRemoved(address(_exchange));
    }

    function setBlockTransfer(bool _ifBlock) public onlyOwner {
        blockTransfer = _ifBlock;
    }

    function setTransferWhitelist(address _white, bool _can) public onlyOwner {
        transferWhitelist[_white] = _can;
    }

    function isExistedExchange(IExchange _exchange) public view override returns (bool) {
        return exchangeMap[address(_exchange)].existed;
    }

    function getAllExchanges() external view override returns (IExchange[] memory) {
        return exchanges;
    }

    function getInsuranceFund(IExchange _exchange) public view override returns (IInsuranceFund) {
        return exchangeMap[address(_exchange)].insuranceFund;
    }

    function insuranceFundFeeRatio() external view override returns (Decimal.decimal memory) {
        return _insuranceFundFeeRatio;
    }

    /**
     * @notice get lp withdraw fee ratio
     * @return lp withdraw fee ratio in 18 digits
     */
    function lpWithdrawFeeRatio() external view override returns (Decimal.decimal memory) {
        return _lpWithdrawFeeRatio;
    }

    function overnightFeeRatio() external view override returns (Decimal.decimal memory) {
        return _overnightFeeRatio;
    }

    function overnightFeeLpShareRatio() external view override returns (Decimal.decimal memory) {
        return _overnightFeeLpShareRatio;
    }

    function fundingFeeLpShareRatio() external view override returns (Decimal.decimal memory) {
        return _fundingFeeLpShareRatio;
    }

    function overnightFeePeriod() external view override returns (uint256) {
        return _overnightFeePeriod;
    }

    function nextOvernightFeeTime(address _exchange) external view override returns (uint256) {
        return exchangeMap[address(_exchange)]._nextOvernightFeeTime;
    }

    function _blockTimestamp() internal view virtual returns (uint256) {
        return block.timestamp;
    }

    function checkTransfer(address _from, address _to) external view override returns (bool) {
        if (!blockTransfer || _from == address(0) || _to == address(0)) return true;
        if (transferWhitelist[_from] || transferWhitelist[_to]) return true;
        return false;
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../Exchange.sol";

contract ExchangeFake is Exchange {
    uint256 private __quoteAssetReserve;
    uint256 private __baseAssetReserve;
    uint256 private __tradeLimitRatio;
    uint256 private __fundingPeriod;
    IPriceFeed private __priceFeed;
    ISakePerp private __SakePerp;
    ISakePerpVault private __SakePerpVault;
    bytes32 private __priceFeedKey;
    address private __quoteAsset;
    uint256 private __fluctuationLimitRatio;
    uint256 private __priceAdjustRatio;
    IExchangeState private __exchangeState;

    constructor(
        uint256 _quoteAssetReserve,
        uint256 _baseAssetReserve,
        uint256 _tradeLimitRatio,
        uint256 _fundingPeriod,
        IPriceFeed _priceFeed,
        ISakePerp _SakePerp,
        ISakePerpVault _SakePerpVault,
        bytes32 _priceFeedKey,
        address _quoteAsset,
        uint256 _fluctuationLimitRatio,
        uint256 _priceAdjustRatio,
        IExchangeState _exchangeState
    ) public {
        __quoteAssetReserve = _quoteAssetReserve;
        __baseAssetReserve = _baseAssetReserve;
        __tradeLimitRatio = _tradeLimitRatio;
        __fundingPeriod = _fundingPeriod;
        __priceFeed = _priceFeed;
        __SakePerp = _SakePerp;
        __SakePerpVault = _SakePerpVault;
        __priceFeedKey = _priceFeedKey;
        __quoteAsset = _quoteAsset;
        __fluctuationLimitRatio = _fluctuationLimitRatio;
        __priceAdjustRatio = _priceAdjustRatio;
        __exchangeState = _exchangeState;
    }

    uint256 private timestamp = 1444004400;
    uint256 private number = 10001;

    function fakeInitialize() public {
        Exchange.initialize(
            __quoteAssetReserve,
            __baseAssetReserve,
            __tradeLimitRatio,
            __fundingPeriod,
            __priceFeed,
            __SakePerp,
            __SakePerpVault,
            __priceFeedKey,
            __quoteAsset,
            __fluctuationLimitRatio,
            __priceAdjustRatio,
            __exchangeState
        );
    }

    function mock_setBlockTimestamp(uint256 _timestamp) public {
        timestamp = _timestamp;
    }

    function mock_setBlockNumber(uint256 _number) public {
        number = _number;
    }

    function mock_getCurrentTimestamp() public view returns (uint256) {
        return _blockTimestamp();
    }

    function mock_getCurrentBlockNumber() public view returns (uint256) {
        return _blockNumber();
    }

    // Override BlockContext here
    function _blockTimestamp() internal view override returns (uint256) {
        return timestamp;
    }

    function _blockNumber() internal view override returns (uint256) {
        return number;
    }

    function getInputPriceWithReservesPublic(
        Dir _dir,
        Decimal.decimal memory _quoteAssetAmount,
        Decimal.decimal memory _quoteAssetPoolAmount,
        Decimal.decimal memory _baseAssetPoolAmount
    ) public view returns (Decimal.decimal memory) {
        return getInputPriceWithReserves(_dir, _quoteAssetAmount, _quoteAssetPoolAmount, _baseAssetPoolAmount);
    }

    function getOutputPriceWithReservesPublic(
        Dir _dir,
        Decimal.decimal memory _baseAssetAmount,
        Decimal.decimal memory _quoteAssetPoolAmount,
        Decimal.decimal memory _baseAssetPoolAmount
    ) public view returns (Decimal.decimal memory) {
        return getOutputPriceWithReserves(_dir, _baseAssetAmount, _quoteAssetPoolAmount, _baseAssetPoolAmount);
    }

    function mockSetReserve(Decimal.decimal memory _quoteReserve, Decimal.decimal memory _baseReserve) public {
        quoteAssetReserve = _quoteReserve;
        baseAssetReserve = _baseReserve;
    }

    function fakeModifyLiquidity() public {
        sakePerpVault.modifyLiquidity();
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./interface/IExchange.sol";
import "./utils/MixedDecimal.sol";

contract ExchangeReader {
    using Decimal for Decimal.decimal;

    struct ExchangeStates {
        uint256 quoteAssetReserve;
        uint256 baseAssetReserve;
        uint256 tradeLimitRatio;
        uint256 spreadRatio;
        uint256 priceAdjustRatio;
        uint256 fluctuationLimitRatio;
        uint256 fundingPeriod;
        string quoteAssetSymbol;
        string baseAssetSymbol;
        bytes32 priceFeedKey;
        uint256 initMarginRatio;
        uint256 maintenanceMarginRatio;
        uint256 liquidationFeeRatio;
        uint256 maxLiquidationFee;
    }

    function getExchangeStates(IExchange exchange) external view returns (ExchangeStates memory) {
        (bool getSymbolSuccess, bytes memory quoteAssetSymbolData) =
            address(exchange.quoteAsset()).staticcall(abi.encodeWithSignature("symbol()"));
        (Decimal.decimal memory quoteAssetReserve, Decimal.decimal memory baseAssetReserve) = exchange.getReserve();
        bytes32 priceFeedKey = exchange.priceFeedKey();

        return
            ExchangeStates({
                quoteAssetReserve: quoteAssetReserve.toUint(),
                baseAssetReserve: baseAssetReserve.toUint(),
                tradeLimitRatio: exchange.tradeLimitRatio(),
                spreadRatio: exchange.spreadRatio().toUint(),
                priceAdjustRatio: exchange.priceAdjustRatio(),
                fluctuationLimitRatio: exchange.fluctuationLimitRatio(),
                fundingPeriod: exchange.fundingPeriod(),
                priceFeedKey: priceFeedKey,
                quoteAssetSymbol: getSymbolSuccess ? abi.decode(quoteAssetSymbolData, (string)) : "",
                baseAssetSymbol: bytes32ToString(priceFeedKey),
                initMarginRatio: exchange.initMarginRatio().toUint(),
                maintenanceMarginRatio: exchange.maintenanceMarginRatio().toUint(),
                liquidationFeeRatio: exchange.liquidationFeeRatio().toUint(),
                maxLiquidationFee: exchange.maxLiquidationFee().toUint()
            });
    }

    // TODO: move to library
    function bytes32ToString(bytes32 _key) private pure returns (string memory) {
        uint8 length;
        while (length < 32 && _key[length] != 0) {
            length++;
        }
        bytes memory bytesArray = new bytes(length);
        for (uint256 i = 0; i < 32 && _key[i] != 0; i++) {
            bytesArray[i] = _key[i];
        }
        return string(bytesArray);
    }
}

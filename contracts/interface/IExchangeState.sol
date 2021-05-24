// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../types/IExchangeTypes.sol";
import "../types/ISakePerpVaultTypes.sol";
import "../utils/Decimal.sol";
import "../utils/SignedDecimal.sol";
import "../MMLPToken.sol";

interface IExchangeState {
    function getMaxHoldingBaseAsset() external view returns (Decimal.decimal memory);

    function getOpenInterestNotionalCap() external view returns (Decimal.decimal memory);

    function initMarginRatio() external view returns (Decimal.decimal memory);

    function maintenanceMarginRatio() external view returns (Decimal.decimal memory);

    function liquidationFeeRatio() external view returns (Decimal.decimal memory);

    function maxLiquidationFee() external view returns (Decimal.decimal memory);

    function spreadRatio() external view returns (Decimal.decimal memory);

    function maxOracleSpreadRatio() external view returns (Decimal.decimal memory);

    function getInputPriceWithReserves(
        IExchangeTypes.Dir _dir,
        Decimal.decimal memory _quoteAssetAmount,
        Decimal.decimal memory _quoteAssetPoolAmount,
        Decimal.decimal memory _baseAssetPoolAmount
    ) external pure returns (Decimal.decimal memory);

    function getOutputPriceWithReserves(
        IExchangeTypes.Dir _dir,
        Decimal.decimal memory _baseAssetAmount,
        Decimal.decimal memory _quoteAssetPoolAmount,
        Decimal.decimal memory _baseAssetPoolAmount
    ) external pure returns (Decimal.decimal memory);

    function calcFee(Decimal.decimal calldata _quoteAssetAmount) external view returns (Decimal.decimal memory);

    function mint(
        ISakePerpVaultTypes.Risk _level,
        address account,
        uint256 amount
    ) external;

    function burn(
        ISakePerpVaultTypes.Risk _level,
        address account,
        uint256 amount
    ) external;

    function getLPToken(ISakePerpVaultTypes.Risk _level) external view returns (MMLPToken);
}

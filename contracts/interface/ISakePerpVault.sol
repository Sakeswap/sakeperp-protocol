// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./IExchange.sol";
import "../utils/Decimal.sol";
import "../utils/SignedDecimal.sol";
import "../types/ISakePerpVaultTypes.sol";

interface ISakePerpVault is ISakePerpVaultTypes {
    function withdraw(
        IExchange _exchange,
        address _receiver,
        Decimal.decimal memory _amount
    ) external;

    function realizeBadDebt(IExchange _exchange, Decimal.decimal memory _badDebt) external;

    function modifyLiquidity() external;

    function getMMLiquidity(address _exchange, Risk _risk) external view returns (SignedDecimal.signedDecimal memory);

    function getAllMMLiquidity(address _exchange)
        external
        view
        returns (SignedDecimal.signedDecimal memory, SignedDecimal.signedDecimal memory);

    function getTotalMMLiquidity(address _exchange) external view returns (SignedDecimal.signedDecimal memory);

    function getTotalMMAvailableLiquidity(address _exchange) external view returns (SignedDecimal.signedDecimal memory);

    function getTotalLpUnrealizedPNL(IExchange _exchange) external view returns (SignedDecimal.signedDecimal memory);

    function addCachedLiquidity(address _exchange, Decimal.decimal memory _DeltalpLiquidity) external;

    function requireMMNotBankrupt(address _exchange) external;

    function getMMCachedLiquidity(address _exchange, Risk _risk) external view returns (Decimal.decimal memory);

    function getTotalMMCachedLiquidity(address _exchange) external view returns (Decimal.decimal memory);

    function setRiskLiquidityWeight(address _exchange, uint256 _highWeight, uint256 _lowWeight) external;

    function setMaxLoss(
        address _exchange,
        Risk _risk,
        uint256 _max
    ) external;
}

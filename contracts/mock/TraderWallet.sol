// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "../utils/Decimal.sol";
import "../utils/SignedDecimal.sol";
import "../utils/MixedDecimal.sol";
import "../utils/BlockContext.sol";
import "../interface/IExchange.sol";
import "../interface/IInsuranceFund.sol";
import "../interface/ISystemSettings.sol";
import "../interface/ISakePerpVault.sol";
import "./SakePerpFake.sol";


import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract TraderWallet {
    SakePerpFake public clearingHouse;

    enum ActionType { OPEN, CLOSE, LIQUIDATE }

    constructor(SakePerpFake _clearingHouse, IERC20Upgradeable _token) public {
        clearingHouse = _clearingHouse;
        _token.approve(address(clearingHouse), uint256(-1));
    }

    function openPosition(
        IExchange _exchange,
        SakePerpFake.Side _side,
        Decimal.decimal calldata _quoteAssetAmount,
        Decimal.decimal calldata _leverage,
        Decimal.decimal calldata _minBaseAssetAmount
    ) external {
        clearingHouse.openPosition(_exchange, _side, _quoteAssetAmount, _leverage, _minBaseAssetAmount);
    }

    function liquidate(IExchange _exchange, address _trader) external {
        clearingHouse.liquidate(_exchange, _trader);
    }

    function closePosition(IExchange _exchange) external {
        clearingHouse.closePosition(_exchange, Decimal.zero());
    }

    function multiActions(
        ActionType _action1,
        bool _setRestriction,
        ActionType _action2,
        IExchange _exchange,
        SakePerpFake.Side _side,
        Decimal.decimal calldata _quoteAssetAmount,
        Decimal.decimal calldata _leverage,
        Decimal.decimal calldata _baseAssetAmountLimit,
        address _trader
    ) external {
        executeAction(_action1, _exchange, _side, _quoteAssetAmount, _leverage, _baseAssetAmountLimit, _trader);
        if (_setRestriction) {
            clearingHouse.mockSetRestrictionMode(_exchange);
        }
        executeAction(_action2, _exchange, _side, _quoteAssetAmount, _leverage, _baseAssetAmountLimit, _trader);
    }

    function twoLiquidations(
        IExchange _exchange,
        address _trader1,
        address _trader2
    ) external {
        clearingHouse.liquidate(_exchange, _trader1);
        clearingHouse.liquidate(_exchange, _trader2);
    }

    function threeLiquidations(
        IExchange _exchange,
        address _trader1,
        address _trader2,
        address _trader3
    ) external {
        clearingHouse.liquidate(_exchange, _trader1);
        clearingHouse.liquidate(_exchange, _trader2);
        clearingHouse.liquidate(_exchange, _trader3);
    }

    function executeAction(
        ActionType _action,
        IExchange _exchange,
        SakePerpFake.Side _side,
        Decimal.decimal memory _quoteAssetAmount,
        Decimal.decimal memory _leverage,
        Decimal.decimal memory _baseAssetAmountLimit,
        address _trader
    ) internal {
        if (_action == ActionType.OPEN) {
            clearingHouse.openPosition(_exchange, _side, _quoteAssetAmount, _leverage, _baseAssetAmountLimit);
        } else if (_action == ActionType.CLOSE) {
            clearingHouse.closePosition(_exchange, Decimal.zero());
        } else if (_action == ActionType.LIQUIDATE) {
            clearingHouse.liquidate(_exchange, _trader);
        }
    }
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import "./utils/BlockContext.sol";
import "./interface/IInsuranceFund.sol";
import "./utils/DecimalERC20.sol";
import "./interface/IExchange.sol";
import "./sakeswap/interfaces/ISakeSwapRouter.sol";

contract InsuranceFund is IInsuranceFund, OwnableUpgradeable, BlockContext, ReentrancyGuardUpgradeable, DecimalERC20 {
    using SafeMathUpgradeable for uint256;

    //
    // EVENTS
    //

    event Withdrawn(address withdrawer, uint256 amount, uint256 badDebt);

    //**********************************************************//
    //    The below state variables can not change the order    //
    //**********************************************************//

    address public beneficiary;
    IExchange public exchange;
    ISakeSwapRouter public router;
    address public sake;
    address public wbnb;

    //**********************************************************//
    //    The above state variables can not change the order    //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // FUNCTIONS
    //

    function initialize(
        IExchange _exchange,
        address _beneficiary,
        address _router,
        address _sake,
        address _wbnb
    ) external initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
        exchange = _exchange;
        beneficiary = _beneficiary;
        router = ISakeSwapRouter(_router);
        sake = _sake;
        wbnb = _wbnb;
    }

    /**
     * @notice withdraw token to caller
     * @param _amount the amount of quoteToken caller want to withdraw
     */
    function withdraw(Decimal.decimal calldata _amount)
        external
        override
        nonReentrant
        returns (Decimal.decimal memory badDebt)
    {
        require(beneficiary == _msgSender(), "caller is not beneficiary");

        IERC20Upgradeable quoteToken = exchange.quoteAsset();
        Decimal.decimal memory quoteBalance = balanceOf(quoteToken);
        Decimal.decimal memory sakeBalance = balanceOfSake(quoteToken);
        Decimal.decimal memory totalBalance = quoteBalance.addD(sakeBalance);
        if (_amount.toUint() > totalBalance.toUint()) {
            badDebt = _amount.subD(totalBalance);
            transfer(quoteToken, _msgSender(), totalBalance, quoteBalance);
            emit Withdrawn(_msgSender(), totalBalance.toUint(), badDebt.toUint());
        } else {
            transfer(quoteToken, _msgSender(), _amount, quoteBalance);
            emit Withdrawn(_msgSender(), _amount.toUint(), 0);
        }
    }

    /**
     * @notice claim token to caller
     * @param _amount the amount of quoteToken caller want to claim
     */
    function claim(Decimal.decimal calldata _amount, bool ifSake) external onlyOwner {
        if (ifSake) {
            _transfer(IERC20Upgradeable(sake), _msgSender(), _amount);
        } else {
            IERC20Upgradeable quoteToken = exchange.quoteAsset();
            _transfer(quoteToken, _msgSender(), _amount);
        }
    }

    /**
     * @notice migrate balance to another contract
     * @param _to the address that the balance will be migrated to
     */
    function migrate(address _to) external onlyOwner {
        require(AddressUpgradeable.isContract(_to), "invalid receiver");
        IERC20Upgradeable quoteToken = exchange.quoteAsset();
        Decimal.decimal memory quoteBalance = balanceOf(quoteToken);
        _transfer(quoteToken, _to, quoteBalance);
        IERC20Upgradeable sakeToken = IERC20Upgradeable(sake);
        Decimal.decimal memory sakeBalance = balanceOf(sakeToken);
        _transfer(sakeToken, _to, sakeBalance);
    }

    /**
     * @notice convert quoteAsset to sake
     */
    function convert(Decimal.decimal calldata _amount, uint256 _minOut) external onlyOwner {
        require(_amount.toUint() > 0, "invalid amount");
        IERC20Upgradeable quoteToken = exchange.quoteAsset();
        Decimal.decimal memory quoteBalance = balanceOf(quoteToken);
        require(quoteBalance.cmp(_amount) >= 0, "exceed total balance");
        _approve(quoteToken, address(router), _amount);
        address[] memory path = new address[](3);
        path[0] = address(quoteToken);
        path[1] = wbnb;
        path[2] = sake;
        router.swapExactTokensForTokens(_amount.toUint(), _minOut, path, address(this), block.timestamp + 10, false);
    }

    function transfer(
        IERC20Upgradeable _quoteToken,
        address _to,
        Decimal.decimal memory _amount,
        Decimal.decimal memory _quoteAmount
    ) internal {
        Decimal.decimal memory needConvertAmount = Decimal.zero();
        uint256 needSellSakeAmount = 0;
        address[] memory path = new address[](3);
        path[0] = sake;
        path[1] = wbnb;
        path[2] = address(_quoteToken);

        if (_quoteAmount.cmp(_amount) < 0) {
            needConvertAmount = _amount.subD(_quoteAmount);
        }

        if (needConvertAmount.toUint() > 0) {
            uint256[] memory amounts = router.getAmountsIn(needConvertAmount.toUint(), path);
            needSellSakeAmount = amounts[0];
        }

        if (needSellSakeAmount > 0) {
            _approve(IERC20Upgradeable(sake), address(router), Decimal.decimal(needSellSakeAmount));
            router.swapExactTokensForTokens(
                needSellSakeAmount,
                needConvertAmount.toUint(),
                path,
                address(this),
                block.timestamp + 10,
                false
            );
        }

        _transfer(_quoteToken, _to, _amount);
    }

    function setExchange(IExchange _exchange) external override onlyOwner {
        exchange = _exchange;
    }

    function setBeneficiary(address _beneficiary) external override onlyOwner {
        beneficiary = _beneficiary;
    }

    function balanceOf(IERC20Upgradeable _quoteToken) internal view returns (Decimal.decimal memory) {
        return _balanceOf(_quoteToken, address(this));
    }

    function balanceOfSake(IERC20Upgradeable _quoteToken) public view returns (Decimal.decimal memory) {
        Decimal.decimal memory sakeBalance = _balanceOf(IERC20Upgradeable(sake), address(this));
        if (sakeBalance.toUint() > 0) {
            address[] memory path = new address[](3);
            path[0] = sake;
            path[1] = wbnb;
            path[2] = address(_quoteToken);
            uint256[] memory amounts = router.getAmountsOut(sakeBalance.toUint(), path);
            return Decimal.decimal(amounts[2]);
        }
        return Decimal.zero();
    }

    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "invalid router address");
        router = ISakeSwapRouter(_router);
    }
}

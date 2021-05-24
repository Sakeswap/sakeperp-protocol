// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import {BaseBridge, IAMB, IMultiTokenMediator, Decimal, IERC20Upgradeable} from "../BaseBridge.sol";
import "../../interface/IL2PriceFeed.sol";

contract RootBridge is BaseBridge {
    using Decimal for Decimal.decimal;

    uint256 public constant DEFAULT_GAS_LIMIT = 2e6;

    //**********************************************************//
    //   The order of below state variables can not be changed  //
    //**********************************************************//

    IL2PriceFeed public priceFeed;

    //**********************************************************//
    //  The order of above state variables can not be changed   //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // PUBLIC
    //
    function initialize(IAMB _ambBridge, IMultiTokenMediator _multiTokenMediator) public initializer {
        __BaseBridge_init(_ambBridge, _multiTokenMediator);
    }

    function updatePriceFeed(
        address _priceFeedAddrOnL2,
        bytes32 _priceFeedKey,
        Decimal.decimal calldata _price,
        uint256 _timestamp,
        uint256 _roundId
    ) external returns (bytes32 messageId) {
        require(address(priceFeed) == _msgSender(), "!priceFeed");

        bytes4 methodSelector = IL2PriceFeed.setLatestData.selector;
        bytes memory data =
            abi.encodeWithSelector(methodSelector, _priceFeedKey, _price.toUint(), _timestamp, _roundId);
        return callBridge(_priceFeedAddrOnL2, data, DEFAULT_GAS_LIMIT);
    }

    function setPriceFeed(address _priceFeed) external onlyOwner {
        priceFeed = IL2PriceFeed(_priceFeed);
    }

    //
    // INTERNALS
    //
}

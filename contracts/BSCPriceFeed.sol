// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;

import "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import "./interface/IBSCPriceFeed.sol";
import "./utils/Decimal.sol";

contract BSCPriceFeed is IBSCPriceFeed, OwnableUpgradeable {
    using SafeMathUpgradeable for uint256;
    using Decimal for Decimal.decimal;

    uint256 private constant TOKEN_DIGIT = 10**18;

    event AggregatorAdded(bytes32 currencyKey, address aggregator);
    event AggregatorRemoved(bytes32 currencyKey, address aggregator);

    // key by currency symbol, eg ETH
    mapping(bytes32 => AggregatorV3Interface) public priceFeedMap;
    bytes32[] public priceFeedKeys;

    //**********************************************************//
    //    Can not change the order of above state variables     //
    //**********************************************************//

    //◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤ add state variables below ◥◤◥◤◥◤◥◤◥◤◥◤◥◤◥◤//

    //◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣ add state variables above ◢◣◢◣◢◣◢◣◢◣◢◣◢◣◢◣//
    uint256[50] private __gap;

    //
    // FUNCTIONS
    //
    function initialize() public initializer {
        __Ownable_init();
    }

    function addAggregator(bytes32 _priceFeedKey, address _aggregator) external onlyOwner {
        requireNonEmptyAddress(_aggregator);
        if (address(priceFeedMap[_priceFeedKey]) == address(0)) {
            priceFeedKeys.push(_priceFeedKey);
        }
        priceFeedMap[_priceFeedKey] = AggregatorV3Interface(_aggregator);
        emit AggregatorAdded(_priceFeedKey, address(_aggregator));
    }

    function removeAggregator(bytes32 _priceFeedKey) external onlyOwner {
        address aggregator = address(priceFeedMap[_priceFeedKey]);
        requireNonEmptyAddress(aggregator);
        delete priceFeedMap[_priceFeedKey];

        uint256 length = priceFeedKeys.length;
        for (uint256 i; i < length; i++) {
            if (priceFeedKeys[i] == _priceFeedKey) {
                // if the removal item is the last one, just `pop`
                if (i != length - 1) {
                    priceFeedKeys[i] = priceFeedKeys[length - 1];
                }
                priceFeedKeys.pop();
                emit AggregatorRemoved(_priceFeedKey, aggregator);
                break;
            }
        }
    }

    function getAggregator(bytes32 _priceFeedKey) public view returns (AggregatorV3Interface) {
        return priceFeedMap[_priceFeedKey];
    }

    function getPrice(bytes32 _priceFeedKey) external view override returns (uint256) {
        require(isExistedKey(_priceFeedKey), "key not existed");
        AggregatorV3Interface aggregator = getAggregator(_priceFeedKey);

        (, int256 _price, , , ) = aggregator.latestRoundData();
        require(_price >= 0, "negative answer");
        uint8 decimals = aggregator.decimals();

        Decimal.decimal memory decimalPrice = Decimal.decimal(formatDecimals(uint256(_price), decimals));

        return decimalPrice.toUint();
    }

    function getLatestTimestamp(bytes32 _priceFeedKey) public view returns (uint256) {
        AggregatorV3Interface aggregator = getAggregator(_priceFeedKey);
        requireNonEmptyAddress(address(aggregator));

        (, , , uint256 timestamp, ) = aggregator.latestRoundData();

        return timestamp;
    }

    function getTwapPrice(bytes32 _priceFeedKey, uint256 _interval) external view override returns (uint256) {
        require(isExistedKey(_priceFeedKey), "key not existed");
        require(_interval != 0, "interval can't be 0");

        // ** We assume L1 and L2 timestamp will be very similar here **
        // 3 different timestamps, `previous`, `current`, `target`
        // `base` = now - _interval
        // `current` = current round timestamp from aggregator
        // `previous` = previous round timestamp form aggregator
        // now >= previous > current > = < base
        //
        //  while loop i = 0
        //  --+------+-----+-----+-----+-----+-----+
        //         base                 current  now(previous)
        //
        //  while loop i = 1
        //  --+------+-----+-----+-----+-----+-----+
        //         base           current previous now

        AggregatorV3Interface aggregator = getAggregator(_priceFeedKey);
        (uint80 roundId, int256 _price, , uint256 timestamp, ) = aggregator.latestRoundData();
        require(_price >= 0, "negative answer");
        uint8 decimals = aggregator.decimals();

        Decimal.decimal memory decimalPrice = Decimal.decimal(formatDecimals(uint256(_price), decimals));
        uint256 latestPrice = decimalPrice.toUint();

        require(roundId >= 0, "Not enough history");
        uint256 latestTimestamp = timestamp;
        uint256 baseTimestamp = block.timestamp.sub(_interval);
        // if latest updated timestamp is earlier than target timestamp, return the latest price.
        if (latestTimestamp < baseTimestamp || roundId == 0) {
            return latestPrice;
        }

        // rounds are like snapshots, latestRound means the latest price snapshot. follow chainlink naming
        uint256 cumulativeTime = block.timestamp.sub(latestTimestamp);
        uint256 previousTimestamp = latestTimestamp;
        uint256 weightedPrice = latestPrice.mul(cumulativeTime);
        while (true) {
            if (roundId == 0) {
                // if cumulative time is less than requested interval, return current twap price
                return weightedPrice.div(cumulativeTime);
            }

            roundId = roundId - 1;
            // get current round timestamp and price
            (, int256 _priceTemp, , uint256 currentTimestamp, ) = aggregator.getRoundData(roundId);
            require(_priceTemp >= 0, "negative answer");

            Decimal.decimal memory decimalPriceTemp = Decimal.decimal(formatDecimals(uint256(_priceTemp), decimals));
            uint256 price = decimalPriceTemp.toUint();

            // check if current round timestamp is earlier than target timestamp
            if (currentTimestamp <= baseTimestamp) {
                // weighted time period will be (target timestamp - previous timestamp). For example,
                // now is 1000, _interval is 100, then target timestamp is 900. If timestamp of current round is 970,
                // and timestamp of NEXT round is 880, then the weighted time period will be (970 - 900) = 70,
                // instead of (970 - 880)
                weightedPrice = weightedPrice.add(price.mul(previousTimestamp.sub(baseTimestamp)));
                break;
            }

            uint256 timeFraction = previousTimestamp.sub(currentTimestamp);
            weightedPrice = weightedPrice.add(price.mul(timeFraction));
            cumulativeTime = cumulativeTime.add(timeFraction);
            previousTimestamp = currentTimestamp;
        }
        return weightedPrice.div(_interval);
    }

    function isExistedKey(bytes32 _priceFeedKey) private view returns (bool) {
        uint256 length = priceFeedKeys.length;
        for (uint256 i; i < length; i++) {
            if (priceFeedKeys[i] == _priceFeedKey) {
                return true;
            }
        }
        return false;
    }

    function requireKeyExisted(bytes32 _key, bool _existed) private view {
        if (_existed) {
            require(isExistedKey(_key), "key not existed");
        } else {
            require(!isExistedKey(_key), "key existed");
        }
    }

    function requireNonEmptyAddress(address _addr) internal pure {
        require(_addr != address(0), "empty address");
    }

    function formatDecimals(uint256 _price, uint8 _decimals) internal pure returns (uint256) {
        return _price.mul(TOKEN_DIGIT).div(10**uint256(_decimals));
    }

    function getPriceFeedLength() public view returns (uint256 length) {
        return priceFeedKeys.length;
    }
}

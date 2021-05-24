// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "../utils/Decimal.sol";
import "../utils/SignedDecimal.sol";

interface ISakePerpTypes {
    //
    // Struct and Enum
    //
    enum Side {BUY, SELL}
    enum PnlCalcOption { SPOT_PRICE, TWAP, ORACLE }

    /// @notice This struct records personal position information
    /// @param size denominated in amm.baseAsset
    /// @param margin isolated margin
    /// @param openNotional the quoteAsset value of position when opening position. the cost of the position
    /// @param lastUpdatedCumulativePremiumFraction for calculating funding payment, record at the moment every time when trader open/reduce/close position
    /// @param lastUpdatedCumulativeOvernightFeeRate for calculating holding fee, record at the moment every time when trader open/reduce/close position
    /// @param liquidityHistoryIndex
    /// @param blockNumber the block number of the last position
    struct Position {
        SignedDecimal.signedDecimal size;
        Decimal.decimal margin;
        Decimal.decimal openNotional;
        SignedDecimal.signedDecimal lastUpdatedCumulativePremiumFraction;
        Decimal.decimal lastUpdatedCumulativeOvernightFeeRate;
        uint256 liquidityHistoryIndex;
        uint256 blockNumber;
    }
}

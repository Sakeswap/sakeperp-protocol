const Side = {
    BUY: 0,
    SELL: 1
}

const Dir = {
    ADD_TO_AMM: 0,
    REMOVE_FROM_AMM: 1
}

const PnlCalcOption = {
    SPOT_PRICE: 0,
    TWAP: 1
}

module.exports = {
    Side,
    Dir,
    PnlCalcOption
}
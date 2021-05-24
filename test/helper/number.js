const BigNumber = require("bignumber.js");
const BN = require("bn.js");

const DEFAULT_TOKEN_DECIMALS = 18
const ONE_DAY = 60 * 60 * 24

// noinspection JSMethodCanBeStatic
function toFullDigit(val, decimals = DEFAULT_TOKEN_DECIMALS) {
    const tokenDigit = new BigNumber("10").exponentiatedBy(decimals)
    const bigNumber = new BigNumber(val).multipliedBy(tokenDigit).toFixed(0)
    return new BN(bigNumber)
}

function toFullDigitStr(val, decimals = DEFAULT_TOKEN_DECIMALS) {
    return toFullDigit(val, decimals).toString()
}

function toDecimal(val, decimals = DEFAULT_TOKEN_DECIMALS) {
    return { d: toFullDigit(val, decimals).toString() }
}

function fromDecimal(val, decimals = DEFAULT_TOKEN_DECIMALS) {
    return new BN(val.d).mul(new BN(10).pow(new BN(decimals))).div(new BN(10).pow(new BN(DEFAULT_TOKEN_DECIMALS)))
}

module.exports = {
    toFullDigit,
    toFullDigitStr,
    toDecimal,
    fromDecimal
}

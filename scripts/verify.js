const shelljs = require("shelljs");
const process = require('process');

let network = process.argv[2]
let contracts = [
    "SakePerp",
    // "SakePerpVault",
    "SakePerpState",
    "SakePerpViewer",
    "Exchange",
    "ExchangeState",
    "ExchangeReader",
    "BSCPriceFeed",
    "ERC20Token",
    "L2PriceFeed",
    "InsuranceFund",
    "SystemSettings"
]

for (let i = 0; i < contracts.length; i++) {
    shelljs.exec("truffle run verify " + contracts[i] + " --network " + network)
}

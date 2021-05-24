const Exchange = artifacts.require("Exchange");
const ExchangeState = artifacts.require("ExchangeState");
const InsuranceFund = artifacts.require("InsuranceFund");
const ProxyAdmin = artifacts.require("ProxyAdmin");
const TransparentUpgradeableProxy = artifacts.require("TransparentUpgradeableProxy");
const SakePerp = artifacts.require("SakePerp");
const SakePerpVault = artifacts.require("SakePerpVault");
const SakePerpState = artifacts.require("SakePerpState");
const SakePerpViewer = artifacts.require("SakePerpViewer");
const SystemSettings = artifacts.require("SystemSettings");
const ERC20Token = artifacts.require("ERC20Token");
const BSCPriceFeed = artifacts.require("BSCPriceFeed");
const ExchangeReader = artifacts.require("ExchangeReader");
const L2PriceFeed = artifacts.require("L2PriceFeed");
const ChainlinkL1 = artifacts.require("ChainlinkL1");
const RootBridge = artifacts.require("RootBridge");
const { toFullDigitStr, toDecimal } = require('../test/helper/number');
const { Contract, providers, Wallet, utils } = require("ethers")

const platform = "bsc"
const providerInfo = {
    "local": {
        "url": "http://127.0.0.1:8545",
        "key": ""
    },
    "kovan": {
        "url": "",
        "key": ""
    },
    "bsc_test": {
        "url": "",
        "key": ""
    },
    "bsc": {
        "url": "https://bsc-dataseed1.defibit.io",
        "key": ""
    },
    "heco_test": {
        "url": "https://http-testnet.hecochain.com",
        "key": ""
    },
    "heco": {
        "url": "https://http-mainnet-node.huobichain.com",
        "key": ""
    },
    "xdai_test": {
        "url": "",
        "key": ""
    },
    "xdai": {
        "url": "",
        "key": ""
    }
}

const provider = new providers.JsonRpcProvider(providerInfo[platform].url)
const wallet = new Wallet(providerInfo[platform].key, provider)

const exchangeArtifact = require("../build/contracts/Exchange.json")
const exchangeStateArtifact = require("../build/contracts/ExchangeState.json")
const exchangeReaderArtifact = require("../build/contracts/ExchangeReader.json")
const SakePerpArtifact = require("../build/contracts/SakePerp.json")
const SakePerpVaultArtifact = require("../build/contracts/SakePerpVault.json")
const systemSettingsArtifact = require("../build/contracts/SystemSettings.json")
const BSCPriceFeedArtifact = require("../build/contracts/BSCPriceFeed.json")
const insuranceFundArtifact = require("../build/contracts/InsuranceFund.json")
const L2PriceFeedArtifact = require("../build/contracts/L2PriceFeed.json")
const SakePerpStateArtifact = require("../build/contracts/SakePerpState.json")
const ProxyAdminArtifact = require("../build/contracts/ProxyAdmin.json")
const SakePerpViewerArtifact = require("../build/contracts/SakePerpViewer.json")

// deploy SakePerpVault through remix firstly
const deployedExchangeImpl = ""
const deployedExchangeStateImpl = ""
const deployedSakePerpStateImpl = ""
const deployedSakePerpViewerImpl = ""
const deployedInsuranceFundImpl = ""
const deployedSakePerpVaultImpl = ""
const deployedSystemSettingsProxy = ""
const deployedSakePerpProxy = ""
const deployedSakePerpValutProxy = ""
const deployedBSCPriceFeedProxy = ""
const deployedL2PriceFeedProxy = ""
const deployedQuoteAsset = ""
const deployedProxyAdmin = ""
const ownerAccount = ""
const router = ""
const sake = ""
const wbnb = ""

const upgradeList = [
    { "proxy": "", "impl": "" },
]

const aggregators = [
    { "key": utils.formatBytes32String('ETH'), "aggregator": "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e" },
    { "key": utils.formatBytes32String('BTC'), "aggregator": "0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf" },
    { "key": utils.formatBytes32String('BNB'), "aggregator": "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE" },
    { "key": utils.formatBytes32String('DOT'), "aggregator": "0xC333eb0086309a16aa7c8308DfD32c8BBA0a2592" },
    { "key": utils.formatBytes32String('LINK'), "aggregator": "0xca236E327F629f9Fc2c30A4E95775EbF0B89fac8" },
]

module.exports = function (deployer) {
    // quoteAssetDeploy(deployer)
    // initialDeploy(deployer, 'ETH')
    // addExchange(deployer, 'DOT')
    // deployL1Oracle(deployer)
    // upgrade(deployer)
    // test(deployer)
};

function initialDeploy(deployer, key) {
    let proxyAdminInstance;
    let exchangeProxy, exchangeInstance;
    let exchangeStateProxy, exchangeStateInstance;
    let exchangeReaderProxy, exchangeReaderInstance;
    let insuranceFundInstance, insuranceFundProxy;
    let SakePerpInstance, SakePerpProxy;
    let SakePerpVaultInstance, SakePerpVaultProxy;
    let SakePerpStateInstance, SakePerpStateProxy;
    let SakePerpViewerInstance, SakePerpViewerProxy;
    let systemSettingsInstance, systemSettingsProxy;
    let BSCPriceFeedInstance, BSCPriceFeedProxy;
    let L2PriceFeedInstance, L2PriceFeedProxy;
    let priceFeedKey = utils.formatBytes32String(key);

    deployer.deploy(ProxyAdmin).then(function (ins) {
        proxyAdminInstance = ins
        return deployer.deploy(InsuranceFund)
    }).then(function (ins) {
        insuranceFundInstance = ins
        return deployer.deploy(BSCPriceFeed)
    }).then(function (ins) {
        BSCPriceFeedInstance = ins
        return deployer.deploy(SakePerp)
    }).then(function (ins) {
        SakePerpInstance = ins
        if (deployedExchangeImpl.length > 0) {
            return { address: deployedExchangeImpl }
        } else {
            return deployer.deploy(Exchange)
        }
    }).then(function (ins) {
        exchangeInstance = ins
        if (deployedExchangeStateImpl.length > 0) {
            return { address: deployedExchangeStateImpl }
        } else {
            return deployer.deploy(ExchangeState)
        }
    }).then(function (ins) {
        exchangeStateInstance = ins
        if (deployedSakePerpStateImpl.length > 0) {
            return { address: deployedSakePerpStateImpl }
        } else {
            return deployer.deploy(SakePerpState)
        }
    }).then(function (ins) {
        SakePerpStateInstance = ins
        if (deployedSakePerpVaultImpl.length > 0) {
            return { address: deployedSakePerpVaultImpl }
        } else {
            return deployer.deploy(SakePerpVault)
        }
    }).then(function (ins) {
        SakePerpVaultInstance = ins
        return deployer.deploy(L2PriceFeed)
    }).then(function (ins) {
        L2PriceFeedInstance = ins
        return deployer.deploy(SystemSettings)
    }).then(function (ins) {
        systemSettingsInstance = ins
        return deployer.deploy(ExchangeReader)
    }).then(function (ins) {
        exchangeReaderInstance = ins
        if (deployedSakePerpViewerImpl.length > 0) {
            return { address: deployedSakePerpViewerImpl }
        } else {
            return deployer.deploy(SakePerpViewer)
        }
    }).then(function (ins) {
        SakePerpViewerInstance = ins
        return deployer.deploy(TransparentUpgradeableProxy, L2PriceFeedInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        L2PriceFeedProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, exchangeInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        exchangeProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, insuranceFundInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        insuranceFundProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, SakePerpInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        SakePerpProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, SakePerpVaultInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        SakePerpVaultProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, systemSettingsInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        systemSettingsProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, BSCPriceFeedInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        BSCPriceFeedProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, SakePerpStateInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        SakePerpStateProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, exchangeStateInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        exchangeStateProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, SakePerpViewerInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        SakePerpViewerProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, exchangeReaderInstance.address, proxyAdminInstance.address, '0x')
    }).then(function (ins) {
        exchangeReaderProxy = ins

        console.log("proxyAdmin:", proxyAdminInstance.address)
        console.log("BSCPriceFeed:", BSCPriceFeedInstance.address)
        console.log("BSCPriceFeedProxy:", BSCPriceFeedProxy.address)
        console.log("L2PriceFeed:", L2PriceFeedInstance.address)
        console.log("L2PriceFeedProxy:", L2PriceFeedProxy.address)
        console.log("InsuranceFund:", insuranceFundInstance.address)
        console.log("InsuranceFundProxy:", insuranceFundProxy.address)
        console.log("SakePerp:", SakePerpInstance.address)
        console.log("SakePerpProxy:", SakePerpProxy.address)
        console.log("SakePerpVault:", SakePerpVaultInstance.address)
        console.log("SakePerpVaultProxy:", SakePerpVaultProxy.address)
        console.log("SakePerpState:", SakePerpStateInstance.address)
        console.log("SakePerpStateProxy:", SakePerpStateProxy.address)
        console.log("SakePerpViewer:", SakePerpViewerInstance.address)
        console.log("SakePerpViewerProxy:", SakePerpViewerProxy.address)
        console.log("systemSettings:", systemSettingsInstance.address)
        console.log("systemSettingsProxy:", systemSettingsProxy.address)
        console.log("exchange:", exchangeInstance.address)
        console.log("exchangeProxy:", exchangeProxy.address)
        console.log("exchangeState:", exchangeStateInstance.address)
        console.log("exchangeStateProxy:", exchangeStateProxy.address)
        console.log("exchangeReader:", exchangeReaderInstance.address)
        console.log("exchangeReaderProxy:", exchangeReaderProxy.address)

        return initialize()
    }).then(function () {
        console.log("complete")
    })

    async function initialize() {
        let tx
        const exchangeContract = new Contract(exchangeProxy.address, exchangeArtifact.abi, wallet)
        const exchangeStateContract = new Contract(exchangeStateProxy.address, exchangeStateArtifact.abi, wallet)
        const insuranceFundContract = new Contract(insuranceFundProxy.address, insuranceFundArtifact.abi, wallet)
        const SakePerpContract = new Contract(SakePerpProxy.address, SakePerpArtifact.abi, wallet)
        const SakePerpVaultContract = new Contract(SakePerpVaultProxy.address, SakePerpVaultArtifact.abi, wallet)
        const SakePerpStateContract = new Contract(SakePerpStateProxy.address, SakePerpStateArtifact.abi, wallet)
        const systemSettingsContract = new Contract(systemSettingsProxy.address, systemSettingsArtifact.abi, wallet)
        const BSCPriceFeedContract = new Contract(BSCPriceFeedProxy.address, BSCPriceFeedArtifact.abi, wallet)
        const exchangeReaderContract = new Contract(exchangeReaderProxy.address, exchangeReaderArtifact.abi, wallet)
        const L2PriceFeedContract = new Contract(L2PriceFeedProxy.address, L2PriceFeedArtifact.abi, wallet)
        const SakePerpViewerContract = new Contract(SakePerpViewerProxy.address, SakePerpViewerArtifact.abi, wallet)

        tx = await exchangeContract.initialize(
            "23916459000000000000000000",
            "8563000000000000000000",
            toFullDigitStr("0.9"),
            "3600",
            BSCPriceFeedProxy.address,
            SakePerpProxy.address,
            SakePerpVaultProxy.address,
            priceFeedKey,
            deployedQuoteAsset,
            toFullDigitStr("0.008"),
            toFullDigitStr("1"),
            exchangeStateProxy.address
        );
        await tx.wait(1)
        console.log("- exchange init complete", tx.hash)

        tx = await exchangeStateContract.initialize(
            exchangeProxy.address,
            toFullDigitStr("0.001"),
            toFullDigitStr("0.06666666666666667"),
            toFullDigitStr("0.03"),
            toFullDigitStr("0.01"),
            toFullDigitStr("100"),
            toFullDigitStr("0.05"),
            systemSettingsProxy.address
        )
        await tx.wait(1)
        console.log("- exchangeState init complete", tx.hash)

        tx = await exchangeStateContract.setCap(toDecimal('1050'), toDecimal('40000000'))
        await tx.wait(1)
        console.log("- exchangeState set cap complete", tx.hash)

        tx = await insuranceFundContract.initialize(exchangeProxy.address, SakePerpVaultProxy.address, router, sake, wbnb)
        await tx.wait(1)
        console.log("- insuranceFund init complete", tx.hash)

        tx = await SakePerpContract.initialize(systemSettingsProxy.address, SakePerpVaultProxy.address, SakePerpStateProxy.address)
        await tx.wait(1)
        console.log("- sakePerp init complete", tx.hash)

        tx = await SakePerpVaultContract.initialize(SakePerpProxy.address, systemSettingsProxy.address, "604800")
        await tx.wait(1)
        console.log("- sakePerpVault init complete", tx.hash)

        tx = await systemSettingsContract.initialize(
            SakePerpProxy.address,
            toFullDigitStr("0.5"),
            toFullDigitStr("0.005"),
            toFullDigitStr("0.0005"),
            toFullDigitStr("0.5"),
            toFullDigitStr("0.5"),
            86400,
        )
        await tx.wait(1)
        console.log("- systemSettings init complete", tx.hash)

        tx = await systemSettingsContract.addExchange(exchangeProxy.address, insuranceFundProxy.address)
        await tx.wait(1)
        console.log("- systemSettings addExchange complete", tx.hash)

        tx = await BSCPriceFeedContract.initialize()
        await tx.wait(1)
        console.log("- BSCPriceFeed init complete", tx.hash)

        tx = await SakePerpStateContract.initialize(SakePerpProxy.address, "360")
        await tx.wait(1)
        console.log("- sakePerpState init complete", tx.hash)

        tx = await SakePerpViewerContract.initialize(SakePerpProxy.address, systemSettingsProxy.address)
        await tx.wait(1)
        console.log("- sakePerpViewer init complete", tx.hash)

        tx = await exchangeContract.setOpen(true)
        await tx.wait(1)
        console.log("- exchange set open complete", tx.hash)

        tx = await exchangeContract.setMover('')
        await tx.wait(1)
        console.log("- exchange set mover complete", tx.hash)
    }
}

function addExchange(deployer, key) {
    let exchangeProxy, exchangeStateProxy, insuranceFundProxy
    let priceFeedKey = utils.formatBytes32String(key)

    deployer.deploy(TransparentUpgradeableProxy, deployedExchangeImpl, deployedProxyAdmin, '0x').then(function (ins) {
        exchangeProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, deployedExchangeStateImpl, deployedProxyAdmin, '0x')
    }).then(function (ins) {
        exchangeStateProxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, deployedInsuranceFundImpl, deployedProxyAdmin, '0x')
    }).then(async function (ins) {
        insuranceFundProxy = ins

        console.log("- add exchange for", key, "success")
        console.log("- exchangeProxy:", exchangeProxy.address)
        console.log("- exchangeStateProxy:", exchangeStateProxy.address)
        console.log("- insuranceFundProxy:", insuranceFundProxy.address)

        let tx
        const exchangeContract = new Contract(exchangeProxy.address, exchangeArtifact.abi, wallet)
        const exchangeStateContract = new Contract(exchangeStateProxy.address, exchangeStateArtifact.abi, wallet)
        const insuranceFundContract = new Contract(insuranceFundProxy.address, insuranceFundArtifact.abi, wallet)
        const systemSettingsContract = new Contract(deployedSystemSettingsProxy, systemSettingsArtifact.abi, wallet)

        tx = await exchangeContract.initialize(
            "6307200000000000000000000",
            "216000000000000000000000",
            toFullDigitStr("0.9"),
            "3600",
            deployedBSCPriceFeedProxy,
            deployedSakePerpProxy,
            deployedSakePerpValutProxy,
            priceFeedKey,
            deployedQuoteAsset,
            toFullDigitStr("0.008"),
            toFullDigitStr("1"),
            exchangeStateProxy.address
        );
        await tx.wait(1)
        console.log("- exchange init complete", tx.hash)

        tx = await exchangeStateContract.initialize(
            exchangeProxy.address,
            toFullDigitStr("0.001"),
            toFullDigitStr("0.06666666666666667"),
            toFullDigitStr("0.03"),
            toFullDigitStr("0.01"),
            toFullDigitStr("100"),
            toFullDigitStr("0.05"),
            deployedSystemSettingsProxy
        )
        await tx.wait(1)
        console.log("- exchangeState init complete", tx.hash)

        tx = await exchangeStateContract.setCap(toDecimal('10000'), toDecimal('7500000'))
        await tx.wait(1)
        console.log("- exchangeState set cap complete", tx.hash)

        tx = await insuranceFundContract.initialize(exchangeProxy.address, deployedSakePerpValutProxy, router, sake, wbnb)
        await tx.wait(1)
        console.log("- insuranceFund init complete", tx.hash)

        tx = await systemSettingsContract.addExchange(exchangeProxy.address, insuranceFundProxy.address)
        await tx.wait(1)
        console.log("- systemSettings addExchange complete", tx.hash)

        tx = await exchangeContract.setOpen(true)
        await tx.wait(1)
        console.log("- exchange set open complete", tx.hash)

        tx = await exchangeContract.setMover('')
        await tx.wait(1)
        console.log("- exchange set mover complete", tx.hash)
    })
}

function deployL1Oracle(deployer) {
    let proxyAdminInstance;
    let chainlinkL1Proxy, chainlinkL1Instance;
    let rootBridgeProxy, rootBridgeInstance;
    deployer.deploy(ProxyAdmin).then(function (ins) {
        proxyAdminInstance = ins
        return deployer.deploy(ChainlinkL1)
    }).then(async function (ins) {
        chainlinkL1Instance = ins
        return deployer.deploy(RootBridge)
    }).then(async function (ins) {
        rootBridgeInstance = ins
        return deployer.deploy(TransparentUpgradeableProxy, chainlinkL1Instance.address, proxyAdminInstance.address, '0x')
    }).then(async function (ins) {
        chainlinkL1Proxy = ins
        return deployer.deploy(TransparentUpgradeableProxy, rootBridgeInstance.address, proxyAdminInstance.address, '0x')
    }).then(async function (ins) {
        rootBridgeProxy = ins
        console.log("proxyAdmin:", proxyAdminInstance.address)
        console.log("chainlinkL1Instance:", chainlinkL1Instance.address)
        console.log("chainlinkL1Proxy:", chainlinkL1Proxy.address)
        console.log("rootBridgeInstance:", rootBridgeInstance.address)
        console.log("rootBridgeProxy:", rootBridgeProxy.address)
    })
}

function upgrade(deployer) {
    const proxyAdminContract = new Contract(deployedProxyAdmin, ProxyAdminArtifact.abi, wallet)
    
    deployer.then(async function() {
        for (let i = 0; i < upgradeList.length; i++) {    
            upgradeInfo = upgradeList[i]
            let tx = await proxyAdminContract.upgrade(upgradeInfo.proxy, upgradeInfo.impl)
            await tx.wait(1)
            console.log("- upgrade ", upgradeInfo.proxy, " ==> ", upgradeInfo.impl)
        }
    })
}

function quoteAssetDeploy(deployer) {
    deployer.deploy(ERC20Token, "BUSD FOR SakePerp TEST", "BUSD", "100000000000000000000000000000").then(function(ins) {
    })
}

function test(deployer) {
    const BSCPriceFeedContract = new Contract(deployedBSCPriceFeedProxy, BSCPriceFeedArtifact.abi, wallet)

    deployer.then(async function() {
        for (let i in aggregators) {
            let aggregator = aggregators[i]
            tx = await BSCPriceFeedContract.addAggregator(aggregator.key, aggregator.aggregator)
            await tx.wait(1)
            console.log("- add aggregator ", i, tx.hash)
            console.log(i, aggregator.key)
        }
    })

    // const exchangeAddresses = [
    //     "",
    //     "",
    //     "",
    //     "",
    //     "",
    //     ""
    // ]

    // deployer.then(async function() {
    //     for (let i in exchangeAddresses) {
    //         let exchangeAddress = exchangeAddresses[i]

    //         const exchangeContract = new Contract(exchangeAddress, exchangeArtifact.abi, wallet)

    //         tx = await exchangeContract.setMover('')
    //         await tx.wait(1)
    //         console.log("- set mover success", i, tx.hash)
    //     }
    // })
}

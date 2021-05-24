const ExchangeFake = artifacts.require('ExchangeFake');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const SakePerpMock = artifacts.require('SakePerpMock');
const SakePerpVault = artifacts.require('SakePerpVaultMock');
const ERC20Token = artifacts.require('ERC20Token');
const { toDecimal, toFullDigitStr, toFullDigit, fromDecimal } = require('./helper/number');
const { utils } = require("ethers");
const { assert } = require('chai');
const ExchangeReader = artifacts.require('ExchangeReader');
const SystemSettings = artifacts.require('SystemSettings');

contract('Exchange', ([alice, bob, carol]) => {
    beforeEach(async () => {
        this.priceFeedKey = utils.formatBytes32String('ETH');
        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10));
        this.SakePerp = await SakePerpMock.new();
        const quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", "10000");
        this.exchangeState = await ExchangeState.new()
        this.sakePerpVault = await SakePerpVault.new()
        this.systemSettings = await SystemSettings.new()

        this.exchange = await ExchangeFake.new(
            toFullDigit("1000"),  // quoteAssetReserve
            toFullDigit("100"),    // baseAssetReserve
            toFullDigit("0.9"),    // tradeLimitRatio
            toFullDigit(60 * 60 * 1),      // fundingPeriod
            this.priceFeed.address,   // priceFeed 
            this.SakePerp.address,         // SakePerp
            this.sakePerpVault.address,         // minter
            this.priceFeedKey,        // priceFeedKey
            quoteAsset.address,       // quoteAsset
            toFullDigit("0.005"),     // fluctuationLimitRatio
            toFullDigit("0.1"),        // priceAdjustRatio
            this.exchangeState.address
        );
        
        this.exchangeState.initialize(
            this.exchange.address,
            toFullDigit("0.001"),
            toFullDigit("0.1"),
            toFullDigit("0.03"),
            toFullDigit("0.01"),
            toFullDigit("200"),
            toFullDigit("0.1"),
            this.systemSettings.address
        )
        
        await this.exchange.fakeInitialize()
        await this.exchange.setExchangeState(this.exchangeState.address)
        this.exchangeReader = await ExchangeReader.new()
        await this.exchange.setOpen(true)
    });

    it('read exchange states', async () => {
        const states = await this.exchangeReader.getExchangeStates(this.exchange.address)
        assert.equal(states.quoteAssetReserve, toFullDigit("1000"))
        assert.equal(states.baseAssetReserve, toFullDigit("100"))
        assert.equal(states.tradeLimitRatio, toFullDigit("0.9"))
        assert.equal(states.spreadRatio, toFullDigit("0.001"))
        assert.equal(states.priceAdjustRatio, toFullDigit("0.1"))
        assert.equal(states.fluctuationLimitRatio, toFullDigit("0.005"))
        assert.equal(states.fundingPeriod, toFullDigit(60 * 60 * 1))
        assert.equal(states.quoteAssetSymbol, "QAT")
        assert.equal(states.baseAssetSymbol, "ETH")
        assert.equal(states.priceFeedKey, this.priceFeedKey)
        assert.equal(states.initMarginRatio, toFullDigit("0.1"))
        assert.equal(states.maintenanceMarginRatio, toFullDigit("0.03"))
        assert.equal(states.liquidationFeeRatio, toFullDigit("0.01"))
        assert.equal(states.maxLiquidationFee, toFullDigit("200"))
    })
})
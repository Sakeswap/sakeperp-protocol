const { BN, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Exchange = artifacts.require('Exchange');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const SakePerp = artifacts.require('SakePerp');
const SakePerpVault = artifacts.require('SakePerpVault');
const SakePerpState = artifacts.require('SakePerpStateFake');
const SystemSettings = artifacts.require('SystemSettings');
const InsuranceFund = artifacts.require('InsuranceFund');
const ERC20Token = artifacts.require('ERC20Token');
const { toDecimal, toFullDigitStr, toFullDigit, fromDecimal } = require('./helper/number');
const { Side } = require('./helper/contract');
const { utils } = require("ethers");

contract('SakePerpState', ([alice, t1, t2, t3, t4]) => {
    beforeEach(async () => {
        this.priceFeedKey = utils.formatBytes32String('ETH')
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigitStr("10000000"))
        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10))

        this.SakePerp = await SakePerp.new()
        this.SakePerpVault = await SakePerpVault.new()
        this.SakePerpState = await SakePerpState.new(this.SakePerp.address, "300")
        this.exchange = await Exchange.new()
        this.exchangeState = await ExchangeState.new()
        this.systemSettings = await SystemSettings.new()
        this.insuraceFund = await InsuranceFund.new();

        await this.exchange.initialize(
            toFullDigitStr("1000"),  // quoteAssetReserve
            toFullDigitStr("100"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            this.priceFeed.address,   // priceFeed 
            this.SakePerp.address,         // SakePerp
            this.SakePerpVault.address,    // minter
            this.priceFeedKey,        // priceFeedKey
            this.quoteAsset.address,  // quoteAsset
            0,                        // fluctuationLimitRatio
            toFullDigitStr("1"),      // priceAdjustRatio
            this.exchangeState.address
        )

        await this.exchangeState.initialize(
            this.exchange.address,
            toFullDigit("0.001"),
            toFullDigit("0.1"),
            toFullDigit("0.03"),
            toFullDigit("0.01"),
            toFullDigit("200"),
            toFullDigit("0.1"),
            this.systemSettings.address
        )

        await this.systemSettings.initialize(
            this.SakePerp.address,
            toFullDigitStr("0.5"),
            toFullDigitStr("0.005"),
            toFullDigitStr("0.003"),
            toFullDigitStr("0.5"),
            toFullDigitStr("0.5"),
            86400,
        );

        await this.SakePerpVault.initialize(this.SakePerp.address, this.systemSettings.address, 0);
        await this.SakePerp.initialize(this.systemSettings.address, this.SakePerpVault.address, this.SakePerpState.address);
        await this.insuraceFund.initialize(this.exchange.address, this.SakePerpVault.address, t1, t1, t1);
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);
        await this.exchange.setOpen(true)
    });

    // it('set', async () => {
    //     assert.equal(await this.SakePerpState.waitingPeriodSecs(), "300")
    //     await this.SakePerpState.setWaitingPeriodSecs("500")
    //     assert.equal(await this.SakePerpState.waitingPeriodSecs(), "500")
    // })

    // it('need to wait before doing reverse trading', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t4, toFullDigit("100000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t3 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t4 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 })
    //     await expectRevert(this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 }),
    //         "cannot open position during waiting period")
    //     const t1TradingTime = await this.SakePerpState.mock_getCurrentTimestamp()
    //     await this.SakePerpState.mock_setBlockTimestamp(t1TradingTime.add(new BN(300)))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t2 })
    //     await expectRevert(this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t2 }),
    //         "cannot open position during waiting period")
    //     const t2TradingTime = await this.SakePerpState.mock_getCurrentTimestamp()
    //     await this.SakePerpState.mock_setBlockTimestamp(t2TradingTime.add(new BN(300)))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t2 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t3 })
    //     await expectRevert(this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from: t3 }),
    //         "cannot close position during waiting period")
    //     const t3TradingTime = await this.SakePerpState.mock_getCurrentTimestamp()
    //     await this.SakePerpState.mock_setBlockTimestamp(t3TradingTime.add(new BN(300)))
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from: t3 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t4 })
    //     await expectRevert(this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from: t4 }),
    //         "cannot close position during waiting period")
    //     const t4TradingTime = await this.SakePerpState.mock_getCurrentTimestamp()
    //     await this.SakePerpState.mock_setBlockTimestamp(t4TradingTime.add(new BN(300)))
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from: t4 })
    // })

    // it('dont need to wait when doing same direction trading', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t4, toFullDigit("100000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t3 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t4 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t2 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t2 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t3 })
    //     const t3TradingTime = await this.SakePerpState.mock_getCurrentTimestamp()
    //     await this.SakePerpState.mock_setBlockTimestamp(t3TradingTime.add(new BN(300)))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("1"), toDecimal(1), toDecimal(0), { from: t3 })
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from: t3 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t4 })
    //     const t4TradingTime = await this.SakePerpState.mock_getCurrentTimestamp()
    //     await this.SakePerpState.mock_setBlockTimestamp(t4TradingTime.add(new BN(300)))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("1"), toDecimal(1), toDecimal(0), { from: t4 })
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from: t4 })
    // })

    it('set waiting whitelist', async () => {
        assert.equal(await this.SakePerpState.waitingWhitelist(t1), false)
        await expectRevert(this.SakePerpState.setWaitingWhitelist(t1, false), "state is the same")
        await this.SakePerpState.setWaitingWhitelist(t1, true)
        assert.equal(await this.SakePerpState.waitingWhitelist(t1), true)
        let whitelist = await this.SakePerpState.getAllWaitingWhitelist()
        assert.equal(whitelist[0], t1)
        await this.SakePerpState.setWaitingWhitelist(t1, false)
        assert.equal(await this.SakePerpState.waitingWhitelist(t1), false)
        whitelist = await this.SakePerpState.getAllWaitingWhitelist()
        assert.equal(whitelist.length, 0)
    })

    it('dont need to wait when doing reverse trading if trader in whitelist', async () => {
        await this.quoteAsset.transfer(t1, toFullDigit("100000"))
        await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from: t1 })
        await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 })
        await expectRevert(this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 }),
            "cannot open position during waiting period")
        await this.SakePerpState.setWaitingWhitelist(t1, true)
        await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10"), toDecimal(1), toDecimal(0), { from: t1 })
    })
})
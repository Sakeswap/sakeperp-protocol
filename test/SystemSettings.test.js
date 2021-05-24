const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Exchange = artifacts.require('Exchange');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const SakePerpVault = artifacts.require('SakePerpVault');
const ERC20Token = artifacts.require('ERC20Token');
const InsuranceFund = artifacts.require('InsuranceFund');
const SakePerp = artifacts.require('SakePerp');
const SystemSettings = artifacts.require('SystemSettings');
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('./helper/number');

function floatToDecimal(percent) {
    return { d: toFullDigit(percent * 10000).div(new BN(10000)).toString() }
}

function DecimalToFloat(decimal) {
    return new BN(decimal.d).div(new BN(10).pow(new BN(14))).toNumber() / 10000
}

contract('SystemSettings', ([alice, bob, carol]) => {
    beforeEach(async () => {
        const priceFeedKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
        const priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10));
        const quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", "10000");
        this.insuraceFund = await InsuranceFund.new();
        this.sakePerpVault = await SakePerpVault.new()
        this.systemSettings = await SystemSettings.new();
        this.SakePerp = await SakePerp.new();
        this.exchange = await Exchange.new();
        this.exchangeState = await ExchangeState.new()

        await this.systemSettings.initialize(
            this.SakePerp.address,
            floatToDecimal(0.5).d,
            floatToDecimal(0.005).d,
            floatToDecimal(0.003).d,
            floatToDecimal(0.5).d,
            floatToDecimal(0.5).d,
            86400,
        );
        
        await this.systemSettings.setInsuranceFundFeeRatio(floatToDecimal(0.5));
        await this.systemSettings.setLpWithdrawFeeRatio(floatToDecimal(0.005));
        await this.SakePerp.initialize(this.systemSettings.address, constants.ZERO_ADDRESS, constants.ZERO_ADDRESS);

        await this.exchange.initialize(
            toFullDigitStr("1000"),  // quoteAssetReserve
            toFullDigitStr("100"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            priceFeed.address,        // priceFeed 
            this.SakePerp.address,         // SakePerp
            this.sakePerpVault.address,         // minter
            priceFeedKey,             // priceFeedKey
            quoteAsset.address,       // quoteAsset
            0,                        // fluctuationLimitRatio
            0,                        // priceAdjustRatio
            this.exchangeState.address
        );

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

        //await this.systemSettings.addExchange(this.exchange.address, insuraceFund.address);
    });

    it('setInsuranceFundFeeRatio', async () => {
        assert.equal(DecimalToFloat(await this.systemSettings.insuranceFundFeeRatio()).toString(), "0.5");
        await expectRevert(this.systemSettings.setInsuranceFundFeeRatio(floatToDecimal(0.01), { from: bob }), "Ownable: caller is not the owner");
    });

    it('setLpWithdrawFeeRatio', async () => {
        assert.equal(DecimalToFloat(await this.systemSettings.lpWithdrawFeeRatio()).toString(), "0.005");
        await expectRevert(this.systemSettings.setLpWithdrawFeeRatio(floatToDecimal(0.01), { from: bob }), "Ownable: caller is not the owner");
    });

    it('addExchange', async () => {
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);
        let exchangeArray = await this.systemSettings.getAllExchanges();
        assert.equal(exchangeArray.length, 1)
        assert.equal(exchangeArray[0], this.exchange.address)
    });

    it('getInsuranceFund', async () => {
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);
        assert.equal(await this.systemSettings.getInsuranceFund(this.exchange.address), this.insuraceFund.address);
    });

    it('removeExchange', async () => {
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);
        await this.systemSettings.removeExchange(this.exchange.address);
        let exchangeArray = await this.systemSettings.getAllExchanges();
        assert.equal(exchangeArray.length, 0)
    });

    it('block lp token transfer', async () => {
        assert.equal(await this.systemSettings.checkTransfer(constants.ZERO_ADDRESS, alice), true)
        assert.equal(await this.systemSettings.checkTransfer(alice, constants.ZERO_ADDRESS), true)
        assert.equal(await this.systemSettings.checkTransfer(alice, bob), false)
        await this.systemSettings.setBlockTransfer(false)
        assert.equal(await this.systemSettings.checkTransfer(alice, bob), true)
        await this.systemSettings.setBlockTransfer(true)
        await this.systemSettings.setTransferWhitelist(alice, true)
        assert.equal(await this.systemSettings.checkTransfer(alice, bob), true)
        assert.equal(await this.systemSettings.checkTransfer(bob, alice), true)
        assert.equal(await this.systemSettings.checkTransfer(bob, carol), false)
        await this.systemSettings.setTransferWhitelist(alice, false)
        assert.equal(await this.systemSettings.checkTransfer(alice, bob), false)
        assert.equal(await this.systemSettings.checkTransfer(bob, alice), false)
    })
})
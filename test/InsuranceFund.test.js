const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Exchange = artifacts.require('Exchange');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const SakePerpMock = artifacts.require('SakePerpMock');
const SakePerpVault = artifacts.require('SakePerpVaultMock');
const ERC20Token = artifacts.require('ERC20Token');
const InsuranceFund = artifacts.require('InsuranceFund');
const SystemSettings = artifacts.require('SystemSettings');
const Receiver = artifacts.require('Receiver');
const SakeSwapRouter = artifacts.require("SakeSwapRouter");
const SakeSwapFactory = artifacts.require("SakeSwapFactory");
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('./helper/number');

contract('InsuranceFund', ([alice, bob]) => {
    beforeEach(async () => {
        const priceFeedKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
        const priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10));
        const SakePerp = await SakePerpMock.new();
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigitStr('10000000000'));
        this.sake = await ERC20Token.new("Sake Token", "Sake", toFullDigitStr('1000000000000'));
        this.insuranceFund = await InsuranceFund.new();
        this.receiver = await Receiver.new();
        const exchange = await Exchange.new();
        this.exchangeState = await ExchangeState.new()
        this.sakePerpVault = await SakePerpVault.new()
        this.systemSettings = await SystemSettings.new()
        
        let wbnb = await ERC20Token.new("WBNB Token", "WBNB", toFullDigitStr('1000000000000'));
        let factory = await SakeSwapFactory.new(alice);
        let router = await SakeSwapRouter.new(factory.address, wbnb.address);
        await factory.createPair(this.sake.address, wbnb.address)
        await factory.createPair(this.quoteAsset.address, wbnb.address)
        await factory.setRouter(router.address)

        await wbnb.approve(router.address, toFullDigitStr('10000000'))
        await this.quoteAsset.approve(router.address, toFullDigitStr('10000000'))
        await this.sake.approve(router.address, toFullDigitStr('10000000'))
        await router.addLiquidity(this.sake.address, wbnb.address, toFullDigitStr('10000'), toFullDigitStr('10000'), 0, 0, alice, 1000000000000)
        await router.addLiquidity(this.quoteAsset.address, wbnb.address, toFullDigitStr('10000'), toFullDigitStr('10000'), 0, 0, alice, 1000000000000)

        await this.exchangeState.initialize(
            exchange.address,
            toFullDigitStr(0),
            toFullDigitStr(0.05),
            toFullDigitStr(0.05),
            toFullDigitStr(0.05),
            toFullDigitStr(100),
            toFullDigitStr(0.1),
            this.systemSettings.address
        )

        await this.insuranceFund.initialize(exchange.address, alice, router.address, this.sake.address, wbnb.address);
        
        await exchange.initialize(
            toFullDigitStr("1000"),   // quoteAssetReserve
            toFullDigitStr("100"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            priceFeed.address,        // priceFeed 
            SakePerp.address,              // SakePerp
            this.sakePerpVault.address,    // minter
            priceFeedKey,             // priceFeedKey
            this.quoteAsset.address,  // quoteAsset
            0,                        // fluctuationLimitRatio
            0,                        // priceAdjustRatio
            this.exchangeState.address
        );
    });

    it('convert', async () => {
        await expectRevert(this.insuranceFund.convert(toDecimal('1'), 0, { from: bob }), "caller is not the owner")
        await expectRevert(this.insuranceFund.convert(toDecimal('0'), 0), "invalid amount")
        await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigitStr('100'))
        await expectRevert(this.insuranceFund.convert(toDecimal('101'), 0), "exceed total balance")
        await this.insuranceFund.convert(toDecimal('50'), "49210556693639764925")
        assert.equal(await this.sake.balanceOf(this.insuranceFund.address), "49210556693639764925")
    })

    it('Withdraw/quoteAsset enough', async () => {
        await expectRevert(this.insuranceFund.withdraw(toDecimal('1'), { from: bob }), "caller is not beneficiary")

        await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigitStr('100'))
        let receipt = await this.insuranceFund.withdraw(toDecimal('10'), { from: alice })
        expectEvent(receipt, "Withdrawn", {
            withdrawer: alice,
            amount: toFullDigitStr('10'),
            badDebt: "0"
        })

        receipt = await this.insuranceFund.withdraw(toDecimal('100'), { from: alice })
        expectEvent(receipt, "Withdrawn", {
            withdrawer: alice,
            amount: toFullDigitStr('90'),
            badDebt: toFullDigitStr('10')
        })
    })

    it('Withdraw/quoteAsset not enough and sake enough', async () => {
        await expectRevert(this.insuranceFund.withdraw(toDecimal('1'), { from: bob }), "caller is not beneficiary")

        await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigitStr('100'))
        await this.insuranceFund.convert(toDecimal('50'), 0)
        let receipt = await this.insuranceFund.withdraw(toDecimal('60'), { from: alice })
        expectEvent(receipt, "Withdrawn", {
            withdrawer: alice,
            amount: toFullDigitStr('60'),
            badDebt: "0"
        })

        assert.equal(await this.sake.balanceOf(this.insuranceFund.address), "39328329616150692815")
    })

    it('Withdraw/quoteAsset not enough and sake not enough', async () => {
        await expectRevert(this.insuranceFund.withdraw(toDecimal('1'), { from: bob }), "caller is not beneficiary")

        await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigitStr('100'))
        await this.insuranceFund.convert(toDecimal('50'), 0)
        let receipt = await this.insuranceFund.withdraw(toDecimal('110'), { from: alice })
        expectEvent(receipt, "Withdrawn", {
            withdrawer: alice,
            amount: "99407084748412959821",
            badDebt: "10592915251587040179"
        })

        assert.equal(await this.sake.balanceOf(this.insuranceFund.address), "0")
    })

    // it('set parameters', async () => {
    //     await expectRevert(this.insuranceFund.setExchange(bob, { from: bob }), "Ownable: caller is not the owner")
    //     await this.insuranceFund.setExchange(bob)
    //     assert.equal(await this.insuranceFund.exchange(), bob)

    //     await expectRevert(this.insuranceFund.setBeneficiary(bob, { from: bob }), "Ownable: caller is not the owner")
    //     await this.insuranceFund.setBeneficiary(bob)
    //     assert.equal(await this.insuranceFund.beneficiary(), bob)

    //     await expectRevert(this.insuranceFund.setRouter(bob, { from: bob }), "Ownable: caller is not the owner")
    //     await this.insuranceFund.setRouter(bob)
    //     assert.equal(await this.insuranceFund.router(), bob)
    // })

    // it('claim', async () => {
    //     await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigitStr('100'))
    //     await this.insuranceFund.transferOwnership(bob)
    //     await this.insuranceFund.convert(toDecimal('50'), { from:bob })
    //     await this.insuranceFund.claim(toDecimal('10'), false, { from:bob })
    //     await this.insuranceFund.claim(toDecimal('10'), true, { from:bob })
    //     assert.equal(await this.quoteAsset.balanceOf(bob), toFullDigitStr('10'))
    //     assert.equal(await this.sake.balanceOf(bob), toFullDigitStr('10'))
    // })

    // it('migrate', async () => {
    //     await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigitStr('100'))
    //     await expectRevert(this.insuranceFund.migrate(bob), "invalid receiver")
    //     await this.insuranceFund.convert(toDecimal('50'))
    //     await this.insuranceFund.migrate(this.receiver.address)
    //     assert.equal(await this.quoteAsset.balanceOf(this.receiver.address), toFullDigitStr('50'))
    //     assert.equal(await this.sake.balanceOf(this.receiver.address), "49210556693639764925")
    // })
})
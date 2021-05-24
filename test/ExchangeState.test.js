const { expectEvent, expectRevert } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const ExchangeState = artifacts.require('ExchangeState');
const MMLPToken = artifacts.require("MMLPToken");
const SystemSettings = artifacts.require('SystemSettings');
const { toDecimal, toFullDigitStr } = require('./helper/number');

contract('ExchangeState', ([alice, bob, carol]) => {
    beforeEach(async () => {
        this.exchangeState = await ExchangeState.new()
        this.systemSettings = await SystemSettings.new()

        await this.exchangeState.initialize(
            alice,
            toFullDigitStr(0.001),
            toFullDigitStr(0.1),
            toFullDigitStr(0.03),
            toFullDigitStr(0.01),
            toFullDigitStr(100),
            toFullDigitStr(0.1),
            this.systemSettings.address
        )

        const LPTokenHigh = await this.exchangeState.getLPToken(0)
        const LPTokenLow = await this.exchangeState.getLPToken(1)
        this.LPTokenHigh = await MMLPToken.at(LPTokenHigh)
        this.LPTokenLow = await MMLPToken.at(LPTokenLow)
    });

    it('default value', async () => {
        assert.equal(await this.exchangeState.spreadRatio(), toFullDigitStr(0.001))
        assert.equal(await this.exchangeState.initMarginRatio(), toFullDigitStr(0.1))
        assert.equal(await this.exchangeState.maintenanceMarginRatio(), toFullDigitStr(0.03))
        assert.equal(await this.exchangeState.liquidationFeeRatio(), toFullDigitStr(0.01))
        assert.equal(await this.exchangeState.maxLiquidationFee(), toFullDigitStr(100))
        assert.equal(await this.exchangeState.getMaxHoldingBaseAsset(), toFullDigitStr(0))
        assert.equal(await this.exchangeState.getOpenInterestNotionalCap(), toFullDigitStr(0))
    })

    it('set value', async () => {
        let tx

        await expectRevert(this.exchangeState.setSpreadRatio(toDecimal(0.002), { from:bob }), "Ownable: caller is not the owner")
        await this.exchangeState.setSpreadRatio(toDecimal(0.002))
        assert.equal(await this.exchangeState.spreadRatio(), toFullDigitStr(0.002))

        await expectRevert(this.exchangeState.setInitMarginRatio(toDecimal(0.2), { from:bob }), "Ownable: caller is not the owner")
        tx = await this.exchangeState.setInitMarginRatio(toDecimal(0.2))
        assert.equal(await this.exchangeState.initMarginRatio(), toFullDigitStr(0.2))
        expectEvent(tx, "InitMarginRatioChanged", {initMarginRatio:toFullDigitStr(0.2)})

        await expectRevert(this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.06), { from:bob }), "Ownable: caller is not the owner")
        tx = await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.06))
        assert.equal(await this.exchangeState.maintenanceMarginRatio(), toFullDigitStr(0.06))
        expectEvent(tx, "MaintenanceMarginRatioChanged", {maintenanceMarginRatio:toFullDigitStr(0.06)})

        await expectRevert(this.exchangeState.setLiquidationFeeRatio(toDecimal(0.02), { from:bob }), "Ownable: caller is not the owner")
        tx = await this.exchangeState.setLiquidationFeeRatio(toDecimal(0.02))
        assert.equal(await this.exchangeState.liquidationFeeRatio(), toFullDigitStr(0.02))
        expectEvent(tx, "LiquidationFeeRatioChanged", {liquidationFeeRatio:toFullDigitStr(0.02)})

        await expectRevert(this.exchangeState.setMaxLiquidationFee(toDecimal(200), { from:bob }), "Ownable: caller is not the owner")
        tx = await this.exchangeState.setMaxLiquidationFee(toDecimal(200))
        assert.equal(await this.exchangeState.maxLiquidationFee(), toFullDigitStr(200))
        expectEvent(tx, "MaxLiquidationFeeChanged", {maxliquidationFee:toFullDigitStr(200)})

        await expectRevert(this.exchangeState.setCap(toDecimal(100), toDecimal(1000), { from:bob }), "Ownable: caller is not the owner")
        tx = await this.exchangeState.setCap(toDecimal(100), toDecimal(1000))
        assert.equal(await this.exchangeState.getMaxHoldingBaseAsset(), toFullDigitStr(100))
        assert.equal(await this.exchangeState.getOpenInterestNotionalCap(), toFullDigitStr(1000))
        expectEvent(tx, "CapChanged", {maxHoldingBaseAsset:toFullDigitStr(100), openInterestNotionalCap:toFullDigitStr(1000)})
    })

    it('mint/burn', async () => {
        await expectRevert(this.exchangeState.mint(0, carol, "1000", { from:bob }), "caller is not exchange")
        await expectRevert(this.exchangeState.burn(0, carol, "1000", { from:bob }), "caller is not exchange")

        await this.exchangeState.mint(0, carol, "1000")
        assert.equal(await this.LPTokenHigh.balanceOf(carol), "1000")
        await this.exchangeState.burn(0, carol, "300")
        assert.equal(await this.LPTokenHigh.balanceOf(carol), "700")

        await this.exchangeState.mint(1, carol, "2000")
        assert.equal(await this.LPTokenLow.balanceOf(carol), "2000")
        await this.exchangeState.burn(1, carol, "300")
        assert.equal(await this.LPTokenLow.balanceOf(carol), "1700")
    })
})
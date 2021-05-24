const { BN, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const AirDrop = artifacts.require('AirDrop');
const ERC20Token = artifacts.require('ERC20Token');
const { toDecimal, toFullDigitStr, toFullDigit, fromDecimal } = require('./helper/number');
const { utils } = require("ethers");

contract('AirDrop', ([alice, t1, t2, t3, t4]) => {
    beforeEach(async () => {
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigitStr("10000000000000"))
        this.airDrop = await AirDrop.new()
    });

    it('testBatch', async () => {
        assert.equal((await this.quoteAsset.balanceOf(t1)), toFullDigitStr("0"))
        assert.equal((await this.quoteAsset.balanceOf(t2)), toFullDigitStr("0"))
        await this.quoteAsset.approve(this.airDrop.address, toFullDigitStr("1500"), {from:alice})
        await this.airDrop.batchTransfer([t1, t2], [toFullDigitStr("1000"), toFullDigitStr("500")], this.quoteAsset.address, {from:alice})
        assert.equal((await this.quoteAsset.balanceOf(t1)), toFullDigitStr("1000"))
        assert.equal((await this.quoteAsset.balanceOf(t2)), toFullDigitStr("500"))
    })
})
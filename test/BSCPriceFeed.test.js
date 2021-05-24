const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Web3 = require('web3')
const ChainlinkL1Mock = artifacts.require('ChainlinkL1Mock');
const BSCPriceFeed = artifacts.require("BSCPriceFeed")

contract('BSC Price Feed', ([alice, bob]) => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    beforeEach(async () => {
        this.chainlinkL1Mock = await ChainlinkL1Mock.new()
        this.BSCPriceFeed = await BSCPriceFeed.new()
        this.BSCPriceFeed.initialize()
    });

    function stringToBytes32(str) {
        return Web3.utils.asciiToHex(str)
    }

    function fromBytes32(str) {
        return Web3.utils.hexToUtf8(str)
    }

    it("addAggregator", async () => {
        await this.BSCPriceFeed.addAggregator(stringToBytes32("ETH"), this.chainlinkL1Mock.address)
        expect(web3.utils.hexToUtf8(await this.BSCPriceFeed.priceFeedKeys(0))).eq("ETH")
        expect(await this.BSCPriceFeed.getAggregator(stringToBytes32("ETH"))).eq(this.chainlinkL1Mock.address)
        expect(await this.BSCPriceFeed.getAggregator(stringToBytes32("BTC"))).eq(EMPTY_ADDRESS)
        await this.BSCPriceFeed.addAggregator(stringToBytes32("BTC"), bob)
        expect(fromBytes32(await this.BSCPriceFeed.priceFeedKeys(1))).eq("BTC")
        expect(await this.BSCPriceFeed.getAggregator(stringToBytes32("BTC"))).eq(bob)
        await expectRevert(this.BSCPriceFeed.addAggregator(stringToBytes32("LINK"), EMPTY_ADDRESS), "empty address")
    })

    it("removeAggregator", async () => {
        await this.BSCPriceFeed.addAggregator(stringToBytes32("ETH"), this.chainlinkL1Mock.address)
        await this.BSCPriceFeed.addAggregator(stringToBytes32("BTC"), this.chainlinkL1Mock.address)
        await this.BSCPriceFeed.removeAggregator(stringToBytes32("ETH"))
        expect(fromBytes32(await this.BSCPriceFeed.priceFeedKeys(0))).eq("BTC")
        expect(await this.BSCPriceFeed.getAggregator(stringToBytes32("ETH"))).eq(EMPTY_ADDRESS)
        expect(await this.BSCPriceFeed.getAggregator(stringToBytes32("BTC"))).eq(this.chainlinkL1Mock.address)
    })

    it("get latest price", async () => {
        await this.BSCPriceFeed.addAggregator(stringToBytes32("ETH"), this.chainlinkL1Mock.address)
        await this.chainlinkL1Mock.mockAddAnswer(8, 12345678, 1, 200000000000, 1)
        await expectRevert(this.BSCPriceFeed.getPrice(stringToBytes32("LINK")), "key not existed")
        await expect(this.BSCPriceFeed.getPrice(stringToBytes32("ETH")), "12345678")
        const receipt = await this.BSCPriceFeed.getPrice(stringToBytes32("ETH"))
        await this.chainlinkL1Mock.mockAddAnswer(9, -1, 2, 200000000001, 2)
        await expectRevert(this.BSCPriceFeed.getPrice(stringToBytes32("ETH")), "negative answer")
    })
})
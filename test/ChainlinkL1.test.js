const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Web3 = require('web3')
const ChainlinkL1Mock = artifacts.require('ChainlinkL1Mock');
const RootBridgeMock = artifacts.require('RootBridgeMock');
const ChainlinkL1 = artifacts.require("ChainlinkL1")

contract('Chainlink L1', ([alice, bob]) => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    beforeEach(async () => {
        this.chainlinkL1Mock = await ChainlinkL1Mock.new()
        this.rootBridgeMock = await RootBridgeMock.new()
        this.chainlinkL1 = await ChainlinkL1.new()
    });

    function stringToBytes32(str) {
        return Web3.utils.asciiToHex(str)
    }

    function fromBytes32(str) {
        return Web3.utils.hexToUtf8(str)
    }

    it('initialize()', async () => {
        await expectRevert(this.chainlinkL1.initialize(EMPTY_ADDRESS, alice), "empty address")
        await expectRevert(this.chainlinkL1.initialize(alice, EMPTY_ADDRESS), "empty address")
    })

    it("set the address of RootBridge", async () => {
        await this.chainlinkL1.initialize(alice, bob)
        await expectRevert(this.chainlinkL1.setRootBridge(EMPTY_ADDRESS), "empty address")
        let receipt = await this.chainlinkL1.setRootBridge(bob, { from: alice })
        expectEvent(receipt, "RootBridgeChanged", { rootBridge: bob })
        expect(await this.chainlinkL1.rootBridge()).eq(bob)
    })

    it("set the address of PriceFeedL2", async () => {
        await this.chainlinkL1.initialize(alice, bob)
        await expectRevert(this.chainlinkL1.setPriceFeedL2(EMPTY_ADDRESS), "empty address")
        const receipt = await this.chainlinkL1.setPriceFeedL2(alice)
        expectEvent(receipt, "PriceFeedL2Changed", { priceFeedL2: alice })
        expect(await this.chainlinkL1.priceFeedL2Address()).eq(alice)
    })

    it("addAggregator", async () => {
        await this.chainlinkL1.initialize(this.rootBridgeMock.address, alice)
        await this.chainlinkL1.addAggregator(stringToBytes32("ETH"), this.chainlinkL1Mock.address)
        expect(web3.utils.hexToUtf8(await this.chainlinkL1.priceFeedKeys(0))).eq("ETH")
        expect(await this.chainlinkL1.getAggregator(stringToBytes32("ETH"))).eq(this.chainlinkL1Mock.address)
        expect(await this.chainlinkL1.getAggregator(stringToBytes32("BTC"))).eq(EMPTY_ADDRESS)
        await this.chainlinkL1.addAggregator(stringToBytes32("BTC"), bob)
        expect(fromBytes32(await this.chainlinkL1.priceFeedKeys(1))).eq("BTC")
        expect(await this.chainlinkL1.getAggregator(stringToBytes32("BTC"))).eq(bob)
        await expectRevert(this.chainlinkL1.addAggregator(stringToBytes32("LINK"), EMPTY_ADDRESS), "empty address")
    })

    it("removeAggregator", async () => {
        await this.chainlinkL1.initialize(this.rootBridgeMock.address, alice)
        await this.chainlinkL1.addAggregator(stringToBytes32("ETH"), this.chainlinkL1Mock.address)
        await this.chainlinkL1.addAggregator(stringToBytes32("BTC"), this.chainlinkL1Mock.address)
        await this.chainlinkL1.removeAggregator(stringToBytes32("ETH"))
        expect(fromBytes32(await this.chainlinkL1.priceFeedKeys(0))).eq("BTC")
        expect(await this.chainlinkL1.getAggregator(stringToBytes32("ETH"))).eq(EMPTY_ADDRESS)
        expect(await this.chainlinkL1.getAggregator(stringToBytes32("BTC"))).eq(this.chainlinkL1Mock.address)
    })

    describe("updateLatestRoundData()", () => {
        const _messageId = 20
        const _messageIdBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000014"

        beforeEach(async () => {
            await this.chainlinkL1.initialize(this.rootBridgeMock.address, alice)
            await this.chainlinkL1.addAggregator(stringToBytes32("ETH"), this.chainlinkL1Mock.address)
            await this.rootBridgeMock.mockSetMessageId(_messageId)
            await this.chainlinkL1Mock.mockAddAnswer(8, 12345678, 1, 200000000000, 1)
        })

        it("get latest data", async () => {
            const receipt = await this.chainlinkL1.updateLatestRoundData(stringToBytes32("ETH"))
            expectEvent(receipt, "PriceUpdateMessageIdSent", { messageId: _messageIdBytes32 })
            // reported price should be normalized to 18 decimals
            assert.equal(await this.rootBridgeMock.price().valueOf(), "123456780000000000")
        })

        it("get latest data, a specified keeper is not required", async () => {
            const receipt = await this.chainlinkL1.updateLatestRoundData(stringToBytes32("ETH"), { from: bob })
            expectEvent(receipt, "PriceUpdateMessageIdSent", { messageId: _messageIdBytes32 })
        })

        // expectRevert section
        it("force error, get non-existing aggregator", async () => {
            const _wrongPriceFeedKey = "Ha"
            await expectRevert(this.chainlinkL1.updateLatestRoundData(stringToBytes32(_wrongPriceFeedKey)), "empty address")
        })

        it("force error, timestamp equal to 0", async () => {
            await this.chainlinkL1Mock.mockAddAnswer(8, 41, 1, 0, 1)
            await expectRevert(this.chainlinkL1.updateLatestRoundData(stringToBytes32("ETH")), "incorrect timestamp")
        })

        it("force error, same timestamp as previous", async () => {
            // first update should pass
            await this.chainlinkL1.updateLatestRoundData(stringToBytes32("ETH"))
            assert.equal(await this.chainlinkL1.prevTimestampMap(stringToBytes32("ETH")).valueOf(), "200000000000")
            // second update with the same timestamp should fail
            await expectRevert(this.chainlinkL1.updateLatestRoundData(stringToBytes32("ETH")), "incorrect timestamp")
        })
    })
})
const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Web3 = require('web3');
const L2PriceFeedFake = artifacts.require('L2PriceFeedFake');
const RootBridgeMock = artifacts.require('RootBridgeMock');
const AMBBridgeMock = artifacts.require('AMBBridgeMock');
const ChainlinkL1 = artifacts.require("ChainlinkL1");
const ExchangeFake = artifacts.require('ExchangeFake');
const SakePerpMock = artifacts.require('SakePerpMock');
const ERC20Token = artifacts.require('ERC20Token');
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('./helper/number');

contract('L2PriceFeed', ([alice, bob]) => {
    beforeEach(async () => {
        this.ambBridge = await AMBBridgeMock.new()
        this.l2PriceFeed = await L2PriceFeedFake.new()
        await this.ambBridge.mockSetMessageSender(alice)
        const SakePerp = await SakePerpMock.new();
        const quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", "10000");
        this.exchange = await ExchangeFake.new(
            toFullDigitStr("1000"),  // quoteAssetReserve
            toFullDigitStr("100"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            this.l2PriceFeed.address,   // priceFeed 
            SakePerp.address,         // SakePerp
            SakePerp.address,         // minter
            toBytes32("ETH"),           // priceFeedKey
            quoteAsset.address,       // quoteAsset
            0,                        // fluctuationLimitRatio
            0,                        // spreadRatio
            0                         // priceAdjustRatio
        );
        await this.l2PriceFeed.initialize(this.ambBridge.address, alice, this.exchange.address)
        await this.exchange.fakeInitialize()
    });

    function toBytes32(str) {
        const paddingLen = 32 - str.length
        const hex = web3.utils.asciiToHex(str)
        return hex + "00".repeat(paddingLen)
    }

    function fromBytes32(str) {
        return Web3.utils.hexToUtf8(str)
    }

    it('addAggregator', async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        expect(fromBytes32(await this.l2PriceFeed.priceFeedKeys(0))).eq("ETH")
    })

    it("add multi aggregators", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.addAggregator(toBytes32("BTC"))
        await this.l2PriceFeed.addAggregator(toBytes32("LINK"))
        expect(fromBytes32(await this.l2PriceFeed.priceFeedKeys(0))).eq("ETH")
        expect(fromBytes32(await this.l2PriceFeed.priceFeedKeys(2))).eq("LINK")
    })

    it("remove 1 aggregator when there's only 1", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.removeAggregator(toBytes32("ETH"))

        // cant use expectRevert because the error message is different between CI and local env
        let error
        try {
            await this.l2PriceFeed.priceFeedKeys(0)
        } catch (e) {
            error = e
        }
        expect(error).not.eq(undefined)
    })

    it("remove 1 aggregator when there're 2", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.addAggregator(toBytes32("BTC"))
        await this.l2PriceFeed.removeAggregator(toBytes32("ETH"))
        expect(fromBytes32(await this.l2PriceFeed.priceFeedKeys(0))).eq("BTC")
        assert.equal(await this.l2PriceFeed.getPriceFeedLength(toBytes32("ETH")).valueOf(), '0')
    })

    it("setLatestData", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()
        const dataTimestamp = currentTime.addn(15)
        const r = await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), dataTimestamp, 1)
        await expectEvent.inTransaction(r.tx, this.l2PriceFeed, "PriceFeedDataSet", {
            key: new BN(toBytes32("ETH")),
            price: toFullDigit(400),
            timestamp: dataTimestamp,
            roundId: "1",
        })
        assert.equal(await this.l2PriceFeed.getPriceFeedLength(toBytes32("ETH")).valueOf(), '1')
        const price = await this.l2PriceFeed.getPrice(toBytes32("ETH"))
        assert.equal(price.valueOf(), toFullDigitStr(400))

        const timestamp = await this.l2PriceFeed.getLatestTimestamp(toBytes32("ETH"))
        assert.equal(timestamp.valueOf(), dataTimestamp.toString())
    })

    it("set multiple data", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()

        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), currentTime.addn(15), 100)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(410), currentTime.addn(30), 101)
        const r = await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(420), currentTime.addn(45), 102)
        await expectEvent.inTransaction(r.tx, this.l2PriceFeed, "PriceFeedDataSet")
        assert.equal(await this.l2PriceFeed.getPriceFeedLength(toBytes32("ETH")).valueOf(), "3")
        const price = await this.l2PriceFeed.getPrice(toBytes32("ETH"))
        assert.equal(price.valueOf(), toFullDigitStr(420))
        const timestamp = await this.l2PriceFeed.getLatestTimestamp(toBytes32("ETH"))
        assert.equal(timestamp.valueOf(), (currentTime.addn(45)).toString())
    })

    it("getPrice after remove the aggregator", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.addAggregator(toBytes32("BTC"))


        const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()

        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), currentTime.addn(15), 100)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(410), currentTime.addn(30), 101)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(420), currentTime.addn(45), 102)

        await this.l2PriceFeed.mockSetMsgSender(alice)
        await this.l2PriceFeed.removeAggregator(toBytes32("ETH"))

        await expectRevert(this.l2PriceFeed.getPrice(toBytes32("ETH")), "key not existed")
        await expectRevert(this.l2PriceFeed.getLatestTimestamp(toBytes32("ETH")), "key not existed")
    })

    it("round id can be the same", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), 1000, 100)
        const r = await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), 1001, 100)
        await expectEvent.inTransaction(r.tx, this.l2PriceFeed, "PriceFeedDataSet")
    })

    it("force error, get data with no price feed data", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.mockSetMsgSender(alice)
        assert.equal(await this.l2PriceFeed.getPriceFeedLength(toBytes32("ETH")).valueOf(), "0")
        assert.equal(await this.l2PriceFeed.getLatestTimestamp(toBytes32("ETH")).valueOf(), "0")
        // expect(await  this.l2PriceFeed.getPriceFeedLength(toBytes32("ETH"))).eq(0)
        // expect(await  this.l2PriceFeed.getLatestTimestamp(toBytes32("ETH"))).eq(0)

        await expectRevert(this.l2PriceFeed.getPrice(toBytes32("ETH")), "no price data")
        await expectRevert(this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 1), "Not enough history")
        await expectRevert(this.l2PriceFeed.getPreviousPrice(toBytes32("ETH"), 0), "Not enough history")
        await expectRevert(this.l2PriceFeed.getPreviousTimestamp(toBytes32("ETH"), 0), "Not enough history")
    })

    it("force error, aggregator should be set first", async () => {
        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        await expectRevert(
            this.l2PriceFeed.setLatestData(toBytes32("BTC"), toFullDigit(400), 1000, 100),
            "key not existed",
        )
    })

    it("force error, timestamp should be larger", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), 1000, 100)
        await expectRevert(
            this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), 999, 101),
            "incorrect timestamp",
        )
    })

    it("force error, timestamp can't be the same", async () => {
        await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
        await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)
        await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), 1000, 100)
        await expectRevert(
            this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), 1000, 101),
            "incorrect timestamp",
        )
    })

    describe("twap", () => {
        beforeEach(async () => {
            await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
            await this.ambBridge.mockSetMessageSender(alice)
            await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)

            const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(15))
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), currentTime.addn(15), 1)
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(30))
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(405), currentTime.addn(30), 2)
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(45))
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(410), currentTime.addn(45), 3)
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(60))
        })

        // aggregator's answer
        // timestamp(base + 0)  : 400
        // timestamp(base + 15) : 405
        // timestamp(base + 30) : 410
        // now = base + 45
        //
        //  --+------+-----+-----+-----+-----+-----+
        //          base                          now

        it("twap price", async () => {
            const price = await this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 45)
            assert.equal(price.valueOf(), toFullDigitStr(405))
        })

        it("asking interval more than aggregator has", async () => {
            const price = await this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 46)
            assert.equal(price.valueOf(), toFullDigitStr(405))
        })

        it("asking interval less than aggregator has", async () => {
            const price = await this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 44)
            assert.equal(price.valueOf(), "405113636363636363636")
        })

        it("given variant price period", async () => {
            const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(30))
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(420), currentTime.addn(30), 4)
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(50))

            // twap price should be (400 * 15) + (405 * 15) + (410 * 45) + (420 * 20) / 95 = 409.74
            const price = await this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 95)
            assert.equal(price.valueOf(), "409736842105263157894")
        })

        it("latest price update time is earlier than the request, return the latest price", async () => {
            const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(100))

            // latest update time is base + 30, but now is base + 145 and asking for (now - 45)
            // should return the latest price directly
            const price = await this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 45)
            assert.equal(price.valueOf(), toFullDigitStr(410))
        })

        it("get 0 while interval is zero", async () => {
            await expectRevert(this.l2PriceFeed.getTwapPrice(toBytes32("ETH"), 0), "interval can't be 0")
        })
    })

    describe("getPreviousPrice/getPreviousTimestamp", () => {
        let baseTimestamp
        beforeEach(async () => {
            await this.l2PriceFeed.addAggregator(toBytes32("ETH"))
            await this.l2PriceFeed.mockSetMsgSender(this.ambBridge.address)

            const currentTime = await this.l2PriceFeed.mock_getCurrentTimestamp()
            baseTimestamp = currentTime
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(400), currentTime.addn(15), 1)
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(405), currentTime.addn(30), 2)
            await this.l2PriceFeed.setLatestData(toBytes32("ETH"), toFullDigit(410), currentTime.addn(45), 3)
            await this.l2PriceFeed.mock_setBlockTimestamp(currentTime.addn(60))
        })

        it("get previous price (latest)", async () => {
            const price = await this.l2PriceFeed.getPreviousPrice(toBytes32("ETH"), 0)
            assert.equal(price.valueOf(), toFullDigitStr(410))
            const timestamp = await this.l2PriceFeed.getPreviousTimestamp(toBytes32("ETH"), 0)
            assert.equal(timestamp.valueOf(), (baseTimestamp.addn(45)).toString())
        })

        it("get previous price", async () => {
            const price = await this.l2PriceFeed.getPreviousPrice(toBytes32("ETH"), 2)
            assert.equal(price.valueOf(), toFullDigitStr(400))
            const timestamp = await this.l2PriceFeed.getPreviousTimestamp(toBytes32("ETH"), 2)
            assert.equal(timestamp.valueOf(), (baseTimestamp.addn(15)).toString())
        })

        it("force error, get previous price", async () => {
            await expectRevert(this.l2PriceFeed.getPreviousPrice(toBytes32("ETH"), 3), "Not enough history")
            await expectRevert(this.l2PriceFeed.getPreviousTimestamp(toBytes32("ETH"), 3), "Not enough history")
        })
    })

})
const { BN, expectEvent, expectRevert, time, constants } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const ExchangeFake = artifacts.require('ExchangeFake');
const Exchange = artifacts.require('Exchange');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const SakePerpMock = artifacts.require('SakePerpMock');
const SakePerpVault = artifacts.require('SakePerpVaultMock');
const ERC20Token = artifacts.require('ERC20Token');
const MMLPToken = artifacts.require("MMLPToken");
const SystemSettings = artifacts.require('SystemSettings');
const { toDecimal, toFullDigitStr, toFullDigit, fromDecimal } = require('./helper/number');
const { Side, Dir, PnlCalcOption } = require('./helper/contract');
const { utils } = require("ethers");

contract('Exchange', ([alice, bob, carol]) => {
    let exchange;
    let fundingPeriod;
    let fundingBufferPeriod;
    let priceFeedKey;
    let SakePerp;

    beforeEach(async () => {
        priceFeedKey = utils.formatBytes32String('ETH');
        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10));
        SakePerp = await SakePerpMock.new();
        this.SakePerpVault = await SakePerpVault.new();
        const quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", "10000");
        this.exchangeState = await ExchangeState.new()
        this.systemSettings = await SystemSettings.new();

        exchange = await ExchangeFake.new(
            toFullDigitStr("1000"),   // quoteAssetReserve
            toFullDigitStr("100"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            this.priceFeed.address,   // priceFeed 
            SakePerp.address,              // SakePerp
            this.SakePerpVault.address,    // SakePerpVault
            priceFeedKey,             // priceFeedKey
            quoteAsset.address,       // quoteAsset
            0,                        // fluctuationLimitRatio
            0,                        // priceAdjustRatio
            this.exchangeState.address
        );
        await exchange.fakeInitialize()

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

        await this.SakePerpVault.setTotalMMAvailableLiquidity(exchange.address, toDecimal("10"));
        await SakePerp.setExchange(exchange.address);
        await exchange.setCounterParty(alice);
        
        await this.systemSettings.initialize(
            SakePerp.address,
            toFullDigitStr(0.5),
            toFullDigitStr(0.005),
            toFullDigitStr(0.003),
            toFullDigitStr(0.5),
            toFullDigitStr(0.5),
            86400,
        );
        await this.systemSettings.addExchange(exchange.address, constants.ZERO_ADDRESS);

        fundingPeriod = await exchange.fundingPeriod()
        fundingBufferPeriod = await exchange.fundingBufferPeriod()
        const LPTokenHigh = await this.exchangeState.getLPToken(0)
        const LPTokenLow = await this.exchangeState.getLPToken(1)
        this.LPTokenHigh = await MMLPToken.at(LPTokenHigh)
        this.LPTokenLow = await MMLPToken.at(LPTokenLow)
    });

    async function initialize() {
        await exchange.setOpen(true)
    }

    async function moveToNextBlocks(number = 1) {
        const blockNumber = new BN(await exchange.mock_getCurrentBlockNumber())
        await exchange.mock_setBlockNumber(blockNumber.add(new BN(number)))
    }

    async function forward(seconds) {
        const timestamp = new BN(await exchange.mock_getCurrentTimestamp())
        await exchange.mock_setBlockTimestamp(timestamp.add(new BN(seconds)))
        const movedBlocks = seconds / 15 < 1 ? 1 : seconds / 15
        await moveToNextBlocks(movedBlocks)
    }

    it('default value', async () => {
        const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(0)
        assert.equal(liquidityChangedSnapshot.quoteAssetReserve, toFullDigitStr("1000"))
        assert.equal(liquidityChangedSnapshot.baseAssetReserve, toFullDigitStr("100"))
        assert.equal(liquidityChangedSnapshot.cumulativeNotional, "0")
    })

    it('setOpen', async () => {
        assert.equal(await exchange.nextFundingTime(), 0)

        const error = "exchange was closed"
        await expectRevert(exchange.settleFunding(), error)
        await expectRevert(exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(600), toDecimal(0)), error)
        await expectRevert(exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(600), toDecimal(0), true), error)

        // given now: October 5, 2015 12:20:00 AM
        const now = await exchange.mock_getCurrentTimestamp()
        assert.equal(now, 1444004400)

        assert.equal(await exchange.open(), false)
        await exchange.setOpen(true)
        assert.equal(await exchange.open(), true)

        // then nextFundingTime should be: October 5, 2015 1:00:00 AM
        assert.equal(await exchange.nextFundingTime(), 1444006800)

        await expectRevert(exchange.setOpen(false, { from: bob }), "Ownable: caller is not the owner")
    })

    it('mint/burn', async () => {
        await initialize()
        await expectRevert(exchange.mint(0, alice, "100"), "caller is not minter")
        await expectRevert(exchange.burn(0, alice, "100"), "caller is not minter")
        await exchange.setMinter(alice)
        assert.equal(await this.LPTokenHigh.balanceOf(alice), "0")
        await exchange.mint(0, alice, "100")
        assert.equal(await this.LPTokenHigh.balanceOf(alice), "100")
        await exchange.burn(0, alice, "50")
        assert.equal(await this.LPTokenHigh.balanceOf(alice), "50")
    })

    it('calculate fee/spread', async () => {
        // spread is 1%
        await this.exchangeState.setSpreadRatio(toDecimal(0.01))
        assert.equal(await exchange.calcFee(toDecimal(10)), toFullDigitStr(0.1))

        // set different fee ratio, spread is 5%
        await this.exchangeState.setSpreadRatio(toDecimal(0.05))
        assert.equal(await exchange.calcFee(toDecimal(100)), toFullDigitStr(5))

        // calcFee with input `0`
        assert.equal(await exchange.calcFee(toDecimal(0)), toFullDigitStr(0))

        // force error, only owner can set spread ratio
        await expectRevert(this.exchangeState.setSpreadRatio(toDecimal(0.2), { from: bob }), "Ownable: caller is not the owner")
    })

    describe("getInputPrice/getOutputPrice", () => {
        beforeEach(async () => {
            await initialize()
        })

        it('getInputPrice/getOutputPrice', async () => {
            let amount;

            // getInputPrice, add to amm
            // amount = 100(quote asset reserved) - (100 * 1000) / (1000 + 50) = 4.7619...
            // price = 50 / 4.7619 = 10.499
            amount = await exchange.getInputPrice(Dir.ADD_TO_AMM, toDecimal(50))
            assert.equal(amount, "4761904761904761904")

            // getInputPrice, remove from amm
            // amount = (100 * 1000) / (1000 - 50) - 100(quote asset reserved) = 5.2631578947368
            // price = 50 / 5.263 = 9.5
            amount = await exchange.getInputPrice(Dir.REMOVE_FROM_AMM, toDecimal(50))
            assert.equal(amount, "5263157894736842106")

            // getOutputPrice, add to amm
            // amount = 1000(base asset reversed) - (100 * 1000) / (100 + 5) = 47.619047619047619048
            // price = 47.619 / 5 = 9.52
            amount = await exchange.getOutputPrice(Dir.ADD_TO_AMM, toDecimal(5))
            assert.equal(amount, "47619047619047619047")

            // getOutputPrice, add to amm with dividable output
            // a dividable number should not plus 1 at mantissa
            amount = await exchange.getOutputPrice(Dir.ADD_TO_AMM, toDecimal(25))
            assert.equal(amount, toFullDigitStr(200))

            // getOutputPrice, remove from amm
            // amount = (100 * 1000) / (100 - 5) - 1000(base asset reversed) = 52.631578947368
            // price = 52.631 / 5 = 10.52
            amount = await exchange.getOutputPrice(Dir.REMOVE_FROM_AMM, toDecimal(5))
            assert.equal(amount, "52631578947368421053")

            // getOutputPrice, remove from amm  with dividable output
            amount = await exchange.getOutputPrice(Dir.REMOVE_FROM_AMM, toDecimal(37.5))
            assert.equal(amount, toFullDigitStr(600))
        })
    })

    describe("swap", () => {
        beforeEach(async () => {
            await initialize()
        })

        // it('totalOpenNotional', async () => {
        //     await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(600), toDecimal(0))
        //     await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(600), toDecimal(0))
        //     assert.equal(await exchange.totalOpenNotional(), toFullDigitStr(1200))

        //     await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(25), toDecimal(0), true)
        //     assert.equal(await exchange.totalOpenNotional(), toFullDigitStr(1000))

        //     await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(25), toDecimal(0), true)
        //     assert.equal(await exchange.totalOpenNotional(), toFullDigitStr(800))
        // })

        it('swapInput/Long', async () => {
            // quote asset = (1000 * 100 / (1000 + 600 ))) - 100 = - 37.5
            const receipt = await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(600), toDecimal(0))
            expectEvent(receipt, "SwapInput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(600),
                baseAssetAmount: toFullDigitStr(37.5),
            })
            expectEvent(receipt, "ReserveSnapshotted", {
                quoteAssetReserve: toFullDigitStr(1600),
                baseAssetReserve: toFullDigitStr(62.5),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1600))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(62.5))
        })

        it('swapInput/short', async () => {
            // quote asset = (1000 * 100 / (1000 - 600)) - 100 = 150
            const receipt = await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(600), toDecimal(0))
            expectEvent(receipt, "SwapInput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(600),
                baseAssetAmount: toFullDigitStr(150),
            })
            expectEvent(receipt, "ReserveSnapshotted", {
                quoteAssetReserve: toFullDigitStr(400),
                baseAssetReserve: toFullDigitStr(250),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(400))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(250))
        })

        it('swapOutput/short', async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(600), toDecimal(0))

            // base asset = 1000 - (1000 * 100 / (100 + 150)) = 600
            const receipt = await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(37.5), toDecimal(0), true)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(600),
                baseAssetAmount: toFullDigitStr(37.5),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it('swapOutput/long', async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(600), toDecimal(0))

            // base asset = (1000 * 100 / (100 - 50)) - 1000 = 1000
            const receipt = await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(150), toDecimal(0), false)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(600),
                baseAssetAmount: toFullDigitStr(150),
            })

            // baseAssetReserve = 1000 * 100 / (1000 + 800) = 55.555...
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it('swapInput/short and then long', async () => {
            // quote asset = (1000 * 100 / (1000 - 480) - 100 = 92.30769230769...
            const response = await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(480), toDecimal(0))
            expectEvent(response, "SwapInput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(480),
                baseAssetAmount: "92307692307692307693",
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(520))
            assert.equal(await exchange.baseAssetReserve(), "192307692307692307693")

            // quote asset = 192.307 - (1000 * 100 / (520 + 960)) = 30.555...
            const response2 = await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(960), toDecimal(0))
            expectEvent(response2, "SwapInput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(960),
                baseAssetAmount: "124740124740124740125",
            })

            // pTokenAfter = 250 - 3000/16 = 1000 / 16
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1480))
            assert.equal(await exchange.baseAssetReserve(), "67567567567567567568")
        })

        it('swapInput/short, long and long', async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(800))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(125))

            // swapped base asset = 13.88...8
            // base reserved = 125 - 13.88...8 = 111.11...2
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(100), toDecimal(0))
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(900))
            assert.equal(await exchange.baseAssetReserve(), "111111111111111111112")

            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(200), toDecimal(0))
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1100))
            assert.equal(await exchange.baseAssetReserve(), "90909090909090909092")
        })

        it('swapInput/short, long and short', async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(25))
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(800))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(125))

            // swapped base asset = 13.88...8
            // base reserved = 125 - 13.88...8 = 111.11...2
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(450), toDecimal(45))
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1250))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(80))

            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(250), toDecimal(20))
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it("swapOutput/short and not dividable", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(200), toDecimal(0))

            const amount = await exchange.getOutputPrice(Dir.ADD_TO_AMM, toDecimal(5))
            const receipt = await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(5), toDecimal(0), true)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: amount.d,
                baseAssetAmount: toFullDigitStr(5),
            })
        })

        it("swapOutput/long and not dividable", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))

            const amount = await exchange.getOutputPrice(Dir.REMOVE_FROM_AMM, toDecimal(5))
            const receipt = await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(5), toDecimal(0), true)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: amount.d,
                baseAssetAmount: toFullDigitStr(5),
            })
        })

        it("swapOutput/long and then short the same size, should got different base asset amount", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(600), toDecimal(0))

            // quote asset = (1000 * 100 / (100 - 10)) - 1000 = 111.111...2
            const amount1 = await exchange.getOutputPrice(Dir.REMOVE_FROM_AMM, toDecimal(10))
            await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(10), toDecimal(0), true)
            assert.equal(await exchange.quoteAssetReserve(), "416666666666666666667")
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(240))

            // quote asset = 1111.111 - (111.111 * 90 / (90 + 10)) = 111.11...1
            // price will be 1 wei less after traded
            const amount2 = await exchange.getOutputPrice(Dir.ADD_TO_AMM, toDecimal(10))
            assert.equal(new BN(amount1.d).sub(new BN(amount2.d)), 1)
        })

        it("force error/swapInput, long but less than min base amount", async () => {
            // long 600 should get 37.5 base asset, and reserves will be 1600:62.5
            // but someone front run it, long 200 before the order 600/37.5
            await exchange.mockSetReserve(toDecimal(1250), toDecimal(80))
            await expectRevert(
                exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(600), toDecimal(37.5)),
                "Less than minimal base token",
            )
        })

        it("force error/swapInput, short but more than min base amount", async () => {
            // short 600 should get -150 base asset, and reserves will be 400:250
            // but someone front run it, short 200 before the order 600/-150
            await exchange.mockSetReserve(toDecimal(800), toDecimal(125))
            await expectRevert(
                exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(600), toDecimal(150)),
                "More than maximal base token",
            )
        })

        it("swapOutput/short, slippage limits of swaps", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            const receipt = await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(20), toDecimal(100), true)

            expectEvent(receipt, "SwapOutput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(250),
                baseAssetAmount: toFullDigitStr(20),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it("swapOutput/short, (amount should pay = 250) at the limit of min quote amount = 249", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            const receipt = await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(20), toDecimal(249), true)

            expectEvent(receipt, "SwapOutput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(250),
                baseAssetAmount: toFullDigitStr(20),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it("force error/swapOutput, short, less than min quote amount = 251", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await expectRevert(
                exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(20), toDecimal(251), true),
                "Less than minimal quote token",
            )
        })

        it("force error/swapOutput, short, far less than min quote amount = 400", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await expectRevert(
                exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(20), toDecimal(400), true),
                "Less than minimal quote token",
            )
        })

        // 800 * 125 / (125 - 25) - 800 = 1000 - 800 = 200
        it("swapOutput/long", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))

            const receipt = await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(25), toDecimal(400), true)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(200),
                baseAssetAmount: toFullDigitStr(25),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it("swapOutput/long, (amount should pay = 200) at the limit of max quote amount = 201", async () => {
            await initialize()
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))

            const receipt = await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(25), toDecimal(201), true)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: toFullDigitStr(200),
                baseAssetAmount: toFullDigitStr(25),
            })

            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
            assert.equal(await exchange.baseAssetReserve(), toFullDigitStr(100))
        })

        it("force error/swapOutput, long, more than max quote amount = 199", async () => {
            await initialize()
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))
            await expectRevert(
                exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(25), toDecimal(199), true),
                "More than maximal quote token",
            )
        })

        it("force error/swapOutput, long, far less more max quote amount = 100", async () => {
            await initialize()
            // base asset = (1000 * 100 / (100 - 50)) - 1000 = 1000
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))
            await expectRevert(
                exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(25), toDecimal(100), true),
                "More than maximal quote token",
            )
        })
    })

    describe("restrict price fluctuation", () => {
        beforeEach(async () => {
            await initialize()
        })

        async function restrictPriceFluctuationInitialize() {
            await exchange.setFluctuationLimitRatio(toDecimal(0.05))
            await exchange.setOpen(true)
            await moveToNextBlocks()
        }

        it("swapInput/price up and under fluctuation", async () => {
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 9.5 ~ 10.5
            // BUY 24, reserve will be 1024 : 97.66, price is 1024 / 97.66 = 10.49
            const receipt = await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(24), toDecimal(0))
            expectEvent(receipt, "SwapInput")
        })

        it("swapInput/price down and under fluctuation", async () => {
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 9.5 ~ 10.5
            // SELL 25, reserve will be 975 : 102.56, price is 975 / 102.56 = 9.51
            const receipt = await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(25), toDecimal(0))
            expectEvent(receipt, "SwapInput")
        })

        it("swapOutput/price up and under fluctuation", async () => {
            // add short position, quoteReserve = 800 baseReserve = 125 price = 6.4
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 6.08 ~ 6.72
            // BUY 3 base, reserve will be 819.67 : 122, price is 819.67 / 122 = 6.718
            const receipt = await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(3), toDecimal(0), true)
            expectEvent(receipt, "SwapOutput")
        })

        it("swapOutput/price down and under fluctuation", async () => {
            // add long position, quoteReserve = 1250 baseReserve = 80 price = 15.625
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 14.84 ~ 16.41
            // SELL 2 base, reserve will be 1219.51 : 82, price is 1219.51 / 82 = 14.87
            const receipt = await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(2), toDecimal(0), true)
            expectEvent(receipt, "SwapOutput")
        })

        it("force error/swapInput, price up but reach the upper limit", async () => {
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 9.5 ~ 10.5
            // BUY 25, reserve will be 1025 : 97.56, price is 1025 / 97.56 = 10.51
            await expectRevert(
                exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(25), toDecimal(0)),
                "price is over fluctuation limit",
            )
        })

        it("force error/swapInput, price down but reach the lower limit", async () => {
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 9.5 ~ 10.5
            // SELL 26, reserve will be 974 : 102.67, price is 974 / 102.67 = 9.49
            await expectRevert(
                exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(26), toDecimal(0)),
                "price is over fluctuation limit",
            )
        })

        it("can swapOutput(close long) even exceeds fluctuation limit if the price impact is larger than the limit, but the rest will fail during that block", async () => {
            // add short position, quoteReserve = 800 baseReserve = 125 price = 6.4
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(200), toDecimal(0))
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 6.08 ~ 6.72
            // BUY 3 base, reserve will be 819.67 : 122, price is 819.67 / 122 = 6.718
            expectEvent(await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(3.1), toDecimal(0), false), "SwapOutput")
            await expectRevert(
                exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(0.1), toDecimal(0), false),
                "price is over fluctuation limit",
            )
        })

        it("can swapOutput(close short) even exceeds fluctuation limit if the price impact is larger than the limit, but the rest will fail during that block", async () => {
            // add long position, quoteReserve = 1250 baseReserve = 80 price = 15.625
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 14.84 ~ 16.41
            // SELL 2 base, reserve will be 1219.51 : 82, price is 1219.51 / 82 = 14.87
            expectEvent(await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(2.1), toDecimal(0), false), "SwapOutput")
            await expectRevert(
                exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(0.1), toDecimal(0), false),
                "price is over fluctuation limit",
            )
        })

        it("force error/swap many times to over the fluctuation in a single block", async () => {
            await restrictPriceFluctuationInitialize()
            // fluctuation is 5%, price is between 9.5 ~ 10.5
            // BUY 10+10+10, reserve will be 1030 : 97.09, price is 1030 / 97.09 = 10.61
            await moveToNextBlocks(1)
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))
            await expectRevert(
                exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0)),
                "price is over fluctuation limit",
            )
        })

        it("force error/compare price fluctuation with previous blocks in a block", async () => {
            await restrictPriceFluctuationInitialize()
            // BUY 10, reserve will be 1010 : 99.01, price is 1010 / 99.01 = 10.2
            // fluctuation is 5%, price is between 9.69 ~ 10.71
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))
            await moveToNextBlocks(1)

            // SELL 26, reserve will be 984 : 101.63, price is 984 / 101.63 = 9.68
            const error = "price is over fluctuation limit"
            await expectRevert(exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(26), toDecimal(0)), error)

            // BUY 30, reserve will be 1040 : 96.15, price is 1040 / 96.15 = 10.82
            await expectRevert(exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(30), toDecimal(0)), error)
            // should revert as well if BUY 30 separately
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))
            await expectRevert(exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(20), toDecimal(0)), error)
        })

        it("force error, the value of fluctuation is the same even when no any tradings for blocks", async () => {
            await restrictPriceFluctuationInitialize()
            // BUY 10, reserve will be 1010 : 99.01, price is 1010 / 99.01 = 10.2
            // fluctuation is 5%, price is between 9.69 ~ 10.71
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))
            await moveToNextBlocks(3)

            // BUY 25, reserve will be 1035 : 96.62, price is 1035 / 96.62 = 10.712
            await expectRevert(
                exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(25), toDecimal(0)),
                "price is over fluctuation limit",
            )
        })
    })

    describe("swapInput and swapOutput", () => {
        beforeEach(async () => {
            await initialize()
        })

        it("use getOutputPrice to query price and use it to swapInput(long)", async () => {
            // when trader ask what's the requiredQuoteAsset if trader want to remove 10 baseAsset from amm
            const requiredQuoteAsset = await exchange.getOutputPrice(Dir.REMOVE_FROM_AMM, toDecimal(10))

            // when trader add requiredQuoteAsset to amm
            const receipt = await exchange.swapInput(Dir.ADD_TO_AMM, requiredQuoteAsset, toDecimal(0))

            // then event.baseAssetAmount should be equal to 10

            expectEvent(receipt, "SwapInput", {
                dir: Dir.ADD_TO_AMM.toString(),
                quoteAssetAmount: requiredQuoteAsset.d,
                baseAssetAmount: toFullDigitStr(10),
            })
        })

        it("use getOutputPrice to query price and use it to swapInput(short)", async () => {
            // when trader ask what's the requiredQuoteAsset if trader want to add 10 baseAsset from amm
            const requiredQuoteAsset = await exchange.getOutputPrice(Dir.ADD_TO_AMM, toDecimal(10))

            // when trader remove requiredQuoteAsset to amm
            const receipt = await exchange.swapInput(Dir.REMOVE_FROM_AMM, requiredQuoteAsset, toDecimal(0))

            // then event.baseAssetAmount should be equal to 10
            expectEvent(receipt, "SwapInput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: requiredQuoteAsset.d,
                baseAssetAmount: toFullDigitStr(10),
            })
        })

        it("use getInputPrice(long) to swapOutput", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))

            // when trader ask what's the baseAsset she will receive if trader want to add 10 quoteAsset to amm
            const receivedBaseAsset = await exchange.getInputPrice(Dir.ADD_TO_AMM, toDecimal(10))

            // when trader trade quoteAsset for receivedBaseAsset (amount as above)
            const receipt = await exchange.swapOutput(Dir.REMOVE_FROM_AMM, receivedBaseAsset, toDecimal(0), true)

            // then event.quoteAsset should be equal to 10
            // if swapOutput is adjusted, the price should be higher (>= 10)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.REMOVE_FROM_AMM.toString(),
                quoteAssetAmount: "9999999999999999999",
                baseAssetAmount: receivedBaseAsset.d,
            })
        })

        it("use getInputPrice(short) to swapOutput", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(100), toDecimal(0))

            // when trader ask what's the baseAsset she will receive if trader want to remove 10 quoteAsset to amm
            const receivedBaseAsset = await exchange.getInputPrice(Dir.REMOVE_FROM_AMM, toDecimal(10))

            // when trader trade quoteAsset for receivedBaseAsset (amount as above)
            const receipt = await exchange.swapOutput(Dir.ADD_TO_AMM, receivedBaseAsset, toDecimal(0), true)

            // then event.quoteAsset should be equal to 10
            // if swapOutput is adjusted, the price should be higher (>= 10)
            expectEvent(receipt, "SwapOutput", {
                dir: Dir.ADD_TO_AMM.toString().toString(),
                quoteAssetAmount: "10000000000000000004",
                baseAssetAmount: receivedBaseAsset.d,
            })
        })

        it("swapInput twice, short and long", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(10), toDecimal(0))
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))

            // then the reserve shouldn't be less than the original reserve
            assert.equal(await exchange.baseAssetReserve(), "100000000000000000001")
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
        })

        it("swapInput twice, long and short", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0))
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(10), toDecimal(0))

            // then the reserve shouldn't be less than the original reserve
            assert.equal(await exchange.baseAssetReserve(), "100000000000000000001")
            assert.equal(await exchange.quoteAssetReserve(), toFullDigitStr(1000))
        })

        it("swapOutput twice, short and long", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(250), toDecimal(0))
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))

            await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(10), toDecimal(0), true)
            await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0), true)

            // then the reserve shouldn't be less than the original reserve
            assert.equal(await exchange.baseAssetReserve(), "100000000000000000001")
            assert.equal(await exchange.quoteAssetReserve(), "1000000000000000000001")
        })

        it("swapOutput twice, long and short", async () => {
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(250), toDecimal(0))
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))

            await exchange.swapOutput(Dir.ADD_TO_AMM, toDecimal(10), toDecimal(0), true)
            await exchange.swapOutput(Dir.REMOVE_FROM_AMM, toDecimal(10), toDecimal(0), true)

            // then the reserve shouldn't be less than the original reserve
            assert.equal(await exchange.baseAssetReserve(), "100000000000000000001")
            assert.equal(await exchange.quoteAssetReserve(), "1000000000000000000001")
        })
    })

    describe("twap price", () => {
        beforeEach(async () => {
            await exchange.setOpen(true)
            // Mainnet average block time is 13.6 secs, 14 is easier to calc
            // create 30 snapshot first, the average price will be 9.04
            await forward(14)
            for (let i = 0; i < 30; i++) {
                // console.log((await exchange.getOutputPrice(Dir.ADD_TO_AMM, toDecimal(10))).d.toString())
                if (i % 3 == 0) {
                    await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))
                } else {
                    await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(50), toDecimal(0))
                }
                await forward(14)
            }
        })

        // Future twap price
        // price will be only
        // 8.12 (after REMOVE_FROM_AMM 100)
        // 9.03 (after ADD_TO_AMM 50),  and
        // 10 (after the second ADD_TO_AMM 50)
        // average is 9.04
        it("get twap price", async () => {
            // 210 / 14 = 15 snapshots,
            // average is 9.04 =
            // (8.12 x 5 snapshots x 14 secs + 9.03 x 5 x 14 + 10 x 5 x 14) / 210
            const twap = await exchange.getTwapPrice(210)
            assert.equal(twap, "9041666666666666665")
        })

        it("the timestamp of latest snapshot is now, the latest snapshot wont have any effect ", async () => {
            // price is 8.12 but time weighted is zero
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))
            // 210 / 14 = 15 snapshots,
            // average is 9.04 =
            // (8.12 x 5 snapshots x 14 secs + 9.03 x 5 x 14 + 10 x 5 x 14) / 210
            const twap = await exchange.getTwapPrice(210)
            assert.equal(twap, "9041666666666666665")
        })

        it("asking interval more than snapshots have", async () => {
            // only have 31 snapshots.
            // average is 9.07 =
            // (8.12 x 10 snapshots x 14 secs + 9.03 x 10 x 14 + 10 x 11 x 14) / (31 x 14))
            assert.equal(await exchange.getTwapPrice(900), "9072580645161290321")
        })

        it("asking interval less than latest snapshot, return latest price directly", async () => {
            // price is 8.1
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))
            await forward(300)
            assert.equal(await exchange.getTwapPrice(210), "8099999999999999998")
        })

        it("price with interval 0 should be the same as spot price", async () => {
            assert.equal(await exchange.getTwapPrice(0), (await exchange.getSpotPrice()).d)
        })

        // Input asset twap price
        // price will be only
        // 1221001221001221002 (after REMOVE_FROM_AMM 100)
        // 1096491228070175439 (after ADD_TO_AMM 50),  and
        // 990099009900990099 (after the second ADD_TO_AMM 50)
        it("get twap price", async () => {
            // total snapshots will be 65, 65 x 14 = 910 secs
            // getInputTwap/getOutputPrice get 15 mins average
            for (let i = 0; i < 34; i++) {
                if (i % 3 == 0) {
                    await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))
                } else {
                    await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(50), toDecimal(0))
                }
                await forward(14)
            }

            //
            // average is 1103873668968336329 =
            // (990099009900990099 x 21 snapshots x 14 secs + 1096491228070175439 x 21 x 14 + 1221001221001221002 x 22 x 14 +
            //  990099009900990099 x 1 snapshots x 4 secs) / 900
            const twap = await exchange.getInputTwap(Dir.ADD_TO_AMM, toDecimal(10))
            assert.equal(twap, "1103873668968336329")
        })

        it("the timestamp of latest snapshot is now, the latest snapshot wont have any effect ", async () => {
            // total snapshots will be 65, 65 x 14 = 910 secs
            // getInputTwap/getOutputPrice get 15 mins average
            for (let i = 0; i < 34; i++) {
                if (i % 3 == 0) {
                    await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))
                } else {
                    await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(50), toDecimal(0))
                }
                await forward(14)
            }

            // price is 8.12 but time weighted is zero
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))

            const twap = await exchange.getInputTwap(Dir.ADD_TO_AMM, toDecimal(10))
            assert.equal(twap, "1103873668968336329")
        })

        it("accumulative time of snapshots is less than 15 mins ", async () => {
            // average is 1098903664504027596 =
            // (990099009900990099 x 11 snapshots x 14 secs + 1096491228070175439 x 10 x 14 + 1221001221001221002 x 10 x 14) / (31 x 14)
            const twap = await exchange.getInputTwap(Dir.ADD_TO_AMM, toDecimal(10))
            assert.equal(twap, "1098903664504027596")
        })

        it("input asset is 0, should return 0", async () => {
            const twap = await exchange.getInputTwap(Dir.ADD_TO_AMM, toDecimal(0))
            assert.equal(twap, "0")
        })

        // output twap
        // Output price will be only
        // 74311926605504587146
        // 82420091324200913231
        // 90909090909090909079
        it("get twap output price", async () => {
            // total snapshots will be 65, 65 x 14 = 910 secs
            // getInputTwap/getOutputPrice get 15 mins average
            for (let i = 0; i < 34; i++) {
                if (i % 3 == 0) {
                    await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(100), toDecimal(0))
                } else {
                    await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(50), toDecimal(0))
                }
                await forward(14)
            }

            //
            // average is 82456099260799524707 =
            // (90909090909090909079 x 21 snapshots x 14 secs + 82420091324200913231 x 21 x 14 + 74311926605504587146 x 22 x 14 +
            //  90909090909090909079 x 1 snapshots x 4 secs) / 900
            const twap = await exchange.getOutputTwap(Dir.ADD_TO_AMM, toDecimal(10))
            assert.equal(twap, "82456099260799524707")
        })

        it("accumulative time of snapshots is less than 15 mins ", async () => {
            // average is 82816779977324354961 =
            // (90909090909090909079 x 11 snapshots x 14 secs + 82420091324200913231 x 10 x 14 + 74311926605504587146 x 10 x 14) / (31 x 14)
            const twap = await exchange.getOutputTwap(Dir.ADD_TO_AMM, toDecimal(10))
            assert.equal(twap, "82816779977324354961")
        })

        it("input asset is 0, should return 0", async () => {
            const twap = await exchange.getOutputTwap(Dir.ADD_TO_AMM, toDecimal(0))
            assert.equal(twap, "0")
        })
    })

    describe("AmmCalculator", () => {
        beforeEach(async () => {
            await initialize()
        })

        it("should return 37.5B when ask for 600Q input at B100/Q1000 reserve and add to Amm", async () => {
            const amount = await exchange.getInputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                toDecimal(600),
                toDecimal(1000),
                toDecimal(100),
            )
            assert.equal(amount, toFullDigitStr(37.5))
        })

        it("should return 150B  when ask for 600Q input at B100/Q1000 reserve and remove from Amm", async () => {
            const amount = await exchange.getInputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(600),
                toDecimal(1000),
                toDecimal(100),
            )
            assert.equal(amount, toFullDigitStr(150))
        })

        it("should get expected (amount - 1) when the base asset amount is not dividable and add to Amm", async () => {
            const amount = await exchange.getInputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                toDecimal(200),
                toDecimal(1000),
                toDecimal(100),
            )
            // 1000 * 100 / 1200 = 83.33
            // 100 - 83.33 = 16.66..7 - 1
            assert.equal(amount, "16666666666666666666")
        })

        it("should get expected amount when the base asset amount is not dividable but remove from Amm", async () => {
            const amount = await exchange.getInputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(100),
                toDecimal(1000),
                toDecimal(100),
            )
            // trader will get 1 wei more negative position size
            assert.equal(amount, "11111111111111111112")
        })

        it("reach trading limit", async () => {
            const amount = await exchange.getInputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(900),
                toDecimal(1000),
                toDecimal(100),
            )
            // 1000 * 100 / 100 = 1000
            // 1000 - 100 = 900
            assert.equal(amount, toFullDigitStr("900"))
        })

        it("force error, value of quote asset is 0", async () => {
            await expectRevert(
                exchange.getInputPriceWithReservesPublic(
                    Dir.REMOVE_FROM_AMM,
                    toDecimal(900),
                    toDecimal(900),
                    toDecimal(900),
                ),
                "quote asset after is 0",
            )
        })

        it("should need 375Q for 60B output at B100/Q1000 reserve when add to Amm", async () => {
            const amount = await exchange.getOutputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                toDecimal(60),
                toDecimal(1000),
                toDecimal(100),
            )
            assert.equal(amount, toFullDigitStr(375))
        })

        it("should need 250Q for 20B output at B100/Q1000 reserve when remove from Amm", async () => {
            const amount = await exchange.getOutputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(20),
                toDecimal(1000),
                toDecimal(100),
            )
            assert.equal(amount, toFullDigitStr(250))
        })

        it("should get expected (amount + 1) when the quote asset amount is not dividable and remove Amm", async () => {
            const amount = await exchange.getOutputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(25),
                toDecimal(1000),
                toDecimal(100),
            )

            // 1000 * 100 / 75 = 1333.33
            // 1333.33 - 1000 = 33.33...3 + 1
            assert.equal(amount, "333333333333333333334")
        })

        it("should get expected amount when the base asset amount is not dividable but add to Amm", async () => {
            const amount = await exchange.getOutputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                toDecimal(20),
                toDecimal(1000),
                toDecimal(100),
            )

            // trader will get 1 wei less quoteAsset
            assert.equal(amount, "166666666666666666666")
        })

        it("force error, value of base asset is 0", async () => {
            await expectRevert(
                exchange.getOutputPriceWithReservesPublic(
                    Dir.REMOVE_FROM_AMM,
                    toDecimal(900),
                    toDecimal(900),
                    toDecimal(900),
                ),
                "base asset after is 0",
            )
        })

        // the result of x's getOutPrice of getInputPrice should be equals to x
        it("without fee, getOutputPrice(getInputPrice(x).amount) == x (quote settlement)", async () => {
            const baseAssetAmount = await exchange.getInputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                toDecimal(250),
                toDecimal(1000),
                toDecimal(100),
            )
            const quoteAssetAmmPrice = await exchange.getOutputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                { d: baseAssetAmount.toString() },
                toDecimal(1250),
                toDecimal(80),
            )
            assert.equal(quoteAssetAmmPrice, toFullDigitStr(250))
        })

        it("without fee, getOutputPrice(getInputPrice(x).amount) == x (base settlement)", async () => {
            const baseAssetAmount = await exchange.getInputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(200),
                toDecimal(1000),
                toDecimal(100),
            )
            const amount = await exchange.getOutputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                { d: baseAssetAmount.toString() },
                toDecimal(800),
                toDecimal(125),
            )
            assert.equal(amount, toFullDigitStr(200))
        })

        it("without fee, getInputPrice(getOutputPrice(x).amount) == x (quote settlement)", async () => {
            const quoteAssetAmmPrice = await exchange.getOutputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                toDecimal(60),
                toDecimal(1000),
                toDecimal(100),
            )
            const baseAssetAmount = await exchange.getInputPriceWithReservesPublic(
                Dir.ADD_TO_AMM,
                { d: quoteAssetAmmPrice.toString() },
                toDecimal(625),
                toDecimal(160),
            )
            assert.equal(baseAssetAmount, toFullDigitStr(60))
        })

        it("without fee, getInputPrice(getOutputPrice(x).amount) == x (base settlement)", async () => {
            const amount = await exchange.getOutputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                toDecimal(60),
                toDecimal(1000),
                toDecimal(100),
            )
            const baseAssetAmount = await exchange.getInputPriceWithReservesPublic(
                Dir.REMOVE_FROM_AMM,
                { d: amount.toString() },
                toDecimal(2500),
                toDecimal(40),
            )
            assert.equal(baseAssetAmount, toFullDigitStr(60))
        })

        // AMM will always get 1 wei more reserve than trader when the result is not dividable
        it("swapInput, add to amm", async () => {
            // add 200 quote, amm: 83.33...4:1200. trader: 12.66
            assert.equal(
                await exchange.getInputPriceWithReservesPublic(
                    Dir.ADD_TO_AMM,
                    toDecimal(200),
                    toDecimal(1000),
                    toDecimal(100),
                ),
                "16666666666666666666"
            )
        })

        it("swapInput, remove from amm", async () => {
            // remove 100 quote, amm: 111.111...1 + 1 wei:900. trader: -11.11...1 - 1wei
            assert.equal(
                await exchange.getInputPriceWithReservesPublic(
                    Dir.REMOVE_FROM_AMM,
                    toDecimal(100),
                    toDecimal(1000),
                    toDecimal(100),
                ),
                "11111111111111111112"
            )
        })

        it("swapOutput, add to amm", async () => {
            // add 20 base, amm: 120:83.33...+ 1 wei. trader: 166.66..6
            assert.equal(
                await exchange.getOutputPriceWithReservesPublic(
                    Dir.ADD_TO_AMM,
                    toDecimal(20),
                    toDecimal(1000),
                    toDecimal(100),
                ),
                "166666666666666666666"
            )
        })

        it("swapOutput, remove from amm", async () => {
            // remove 10 base, amm: 90:1111.11...1 + 1 wei. trader: -111.11 - 1 wei
            assert.equal(
                await exchange.getOutputPriceWithReservesPublic(
                    Dir.REMOVE_FROM_AMM,
                    toDecimal(10),
                    toDecimal(1000),
                    toDecimal(100),
                ),
                "111111111111111111112"
            )
        })
    })

    describe("settle Funding/migrate liquidity", () => {
        beforeEach(async () => {
            await initialize()
        })

        it("settleFunding delay before fundingBufferPeriod ends", async () => {
            await exchange.setCounterParty(SakePerp.address);
            const originalNextFundingTime = await exchange.nextFundingTime()
            const settleFundingTimestamp = originalNextFundingTime.add(fundingBufferPeriod).subn(1)
            await exchange.mock_setBlockTimestamp(settleFundingTimestamp)
            await SakePerp.settleFunding()
            assert.equal(await exchange.nextFundingTime(), originalNextFundingTime.add(fundingPeriod).toString())
        })

        it("settleFunding delay after fundingBufferPeriod ends & before nextFundingTime", async () => {
            await exchange.setCounterParty(SakePerp.address);
            const originalNextFundingTime = await exchange.nextFundingTime()
            const settleFundingTimestamp = originalNextFundingTime.add(fundingBufferPeriod).addn(1)
            await exchange.mock_setBlockTimestamp(settleFundingTimestamp)
            await SakePerp.settleFunding()
            assert.equal(await exchange.nextFundingTime(), new BN(settleFundingTimestamp).add(fundingBufferPeriod).toString())
        })

        it("don't update fundingRate when AMM price has been moved before nextFundingTime", async () => {
            await exchange.setCounterParty(SakePerp.address);
            const originalNextFundingTime = await exchange.nextFundingTime()
            const moveAMMPriceTime = originalNextFundingTime.sub(fundingPeriod.div(new BN(2)))
            await exchange.mock_setBlockTimestamp(moveAMMPriceTime)
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            await exchange.moveAMMPriceToOracle(toFullDigit(11), priceFeedKey)
            const settleFundingTimestamp = originalNextFundingTime.addn(1)
            await exchange.mock_setBlockTimestamp(settleFundingTimestamp)
            const fundingRateOld = await exchange.fundingRate()
            await SakePerp.settleFunding()
            const fundingRateNew = await exchange.fundingRate()
            assert.equal(fundingRateOld.d, fundingRateNew.d)
            assert.equal(await exchange.nextFundingTime(), new BN(originalNextFundingTime).add(fundingPeriod).toString())
        })

        it("force error, caller is not counterParty/SakePerp", async () => {
            await expectRevert(exchange.settleFunding({ from:bob }), "caller is not counterParty")
        })

        it("can't settleFunding multiple times at once even settleFunding delay", async () => {
            await exchange.setCounterParty(SakePerp.address);
            const startAt = await exchange.mock_getCurrentTimestamp()
            const delayDuration = fundingPeriod.muln(10)
            const settleFundingTimestamp = new BN(startAt).add(delayDuration)
            await exchange.mock_setBlockTimestamp(settleFundingTimestamp)
            await SakePerp.settleFunding()
            await expectRevert(SakePerp.settleFunding(), "settle funding too early")
        })

        it("change maxHoldingBaseAsset and openInterestNotionalCap", async () => {
            const receipt = await this.exchangeState.setCap(toDecimal(100), toDecimal(200))
            expectEvent(receipt, "CapChanged", {
                maxHoldingBaseAsset: toFullDigitStr(100),
                openInterestNotionalCap: toFullDigitStr(200)
            })
            assert.equal(await exchange.getMaxHoldingBaseAsset(), toFullDigitStr(100))
            assert.equal(await exchange.getOpenInterestNotionalCap(), toFullDigitStr(200))
        })

        it("increase liquidity", async () => {
            // long:20 short:45     move price to 800:125
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await exchange.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))

            // when exchange.migrateLiquidity(2, toDecimal(0)) from 800:125 to 1600:250
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            const reserve = await exchange.getReserve()
            assert.equal(reserve[0], toFullDigitStr(1600))
            assert.equal(reserve[1], toFullDigitStr(250))

            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.quoteAssetReserve, toFullDigitStr(1600))
            assert.equal(liquidityChangedSnapshot.baseAssetReserve, toFullDigitStr(250))
            assert.equal(liquidityChangedSnapshot.cumulativeNotional, toFullDigitStr(-200))
        })

        it("decrease liquidity", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            // when exchange.migrateLiquidity(0.5, toDecimal(0)) from 80:1250 to 40:625
            await exchange.migrateLiquidity(toDecimal(0.5), toDecimal(0))

            const reserve = await exchange.getReserve()
            assert.equal(reserve[0], toFullDigitStr(625))
            assert.equal(reserve[1], toFullDigitStr(40))

            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.quoteAssetReserve, toFullDigitStr(625))
            assert.equal(liquidityChangedSnapshot.baseAssetReserve, toFullDigitStr(40))
            assert.equal(liquidityChangedSnapshot.cumulativeNotional, toFullDigitStr(250))
        })

        it("will fail if the liquidity is the same", async () => {
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            // when exchange.migrateLiquidity(1, toDecimal(0)) from 80:1250 to the same reserve
            // 133.33%
            await expectRevert(exchange.migrateLiquidity(toDecimal(1), toDecimal(0)), "multiplier can't be 1")
        })

        // fluctuation limit test
        it("open a valid position while increasing liquidity", async () => {
            // originally 100: 1000, price = 10
            // move to 80: 1250, price = 15.625
            await forward(15)
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0.563))

            const reserve = await exchange.getReserve()
            assert.equal(reserve[0], toFullDigitStr(2500))
            assert.equal(reserve[1], toFullDigitStr(160))
        })

        it("force error, open an invalid position (over fluctuation) while increasing liquidity", async () => {
            await forward(15)
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await expectRevert(exchange.migrateLiquidity(toDecimal(2), toDecimal(0.562)), "price is over fluctuation limit")
        })

        it("open a valid position while decreasing liquidity", async () => {
            await forward(15)
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await exchange.migrateLiquidity(toDecimal(0.5), toDecimal(0.563))

            const reserve = await exchange.getReserve()
            assert.equal(reserve[0], toFullDigitStr(625))
            assert.equal(reserve[1], toFullDigitStr(40))
        })

        it("force error, open an invalid position (over fluctuation) while decreasing liquidity", async () => {
            await forward(15)
            await exchange.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))

            await expectRevert(
                exchange.migrateLiquidity(toDecimal(0.5), toDecimal(0.562)),
                "price is over fluctuation limit",
            )
        })
    })

    describe("move AMM price", () => {
        beforeEach(async () => {
            await initialize()
            await exchange.setCounterParty(SakePerp.address);
        })

        it("move amm price out of limitation", async () => {
            assert.equal(await exchange.oraclePriceSpreadLimit(), toFullDigitStr("0.3"))
            await exchange.setOraclePriceSpreadLimit(toDecimal("0.1"))
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            assert.equal(await exchange.oraclePriceSpreadLimit(), toFullDigitStr("0.1"))
            
            // amm price is 10, oracle price should between 9 and 11
            await expectRevert(exchange.moveAMMPriceToOracle(toFullDigit("8"), priceFeedKey), "invalid oracle price")
            await expectRevert(exchange.moveAMMPriceToOracle(toFullDigit("12"), priceFeedKey), "invalid oracle price")
            await exchange.moveAMMPriceToOracle(toFullDigit("9.1"), priceFeedKey)
        })

        it("move amm price", async () => {    
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));

            // priceAdjustRatio = 0
            await exchange.moveAMMPriceToOracle(toFullDigit(1000), priceFeedKey)
            let reserve = await exchange.getReserve()
            assert.equal(reserve[0].d, toFullDigitStr(1000))
            assert.equal(reserve[1].d, toFullDigitStr(100))
    
            let snapshotLen = await exchange.getSnapshotLen()
            let snapshot = await exchange.reserveSnapshots(snapshotLen - 1)
            assert.equal(snapshot.quoteAssetReserve, toFullDigitStr(1000))
            assert.equal(snapshot.baseAssetReserve, toFullDigitStr(100))
    
            // priceAdjustRatio = 10
            await exchange.setPriceAdjustRatio(toDecimal("0.1"))
            await expectRevert(exchange.moveAMMPriceToOracle(toFullDigit(10), utils.formatBytes32String('ETH0')), "illegal price feed key")
            await expectRevert(exchange.moveAMMPriceToOracle(toFullDigit(0), priceFeedKey), "oracle price can't be zero")
    
            // adjustPrice = 100
            await exchange.moveAMMPriceToOracle(toFullDigit(910), priceFeedKey)
            reserve = await exchange.getReserve()
            assert.equal(reserve[0].d, "3162277660168379332097")
            assert.equal(reserve[1].d, "31622776601683793319")
    
            snapshotLen = await exchange.getSnapshotLen()
            snapshot = await exchange.reserveSnapshots(snapshotLen - 1)
            assert.equal(snapshot.quoteAssetReserve, "3162277660168379332097")
            assert.equal(snapshot.baseAssetReserve, "31622776601683793319")
    
            // priceAdjustRatio = 100
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            await expectRevert(exchange.moveAMMPriceToOracle(toFullDigit(10), utils.formatBytes32String('ETH0')), "illegal price feed key")
            await expectRevert(exchange.moveAMMPriceToOracle(toFullDigit(0), priceFeedKey), "oracle price can't be zero")
    
            // adjustPrice = 1000
            await exchange.moveAMMPriceToOracle(toFullDigit(1000), priceFeedKey)
            reserve = await exchange.getReserve()
            assert.equal(reserve[0].d, "10000000000000000000997")
            assert.equal(reserve[1].d, "9999999999999999999")
    
            snapshotLen = await exchange.getSnapshotLen()
            snapshot = await exchange.reserveSnapshots(snapshotLen - 1)
            assert.equal(snapshot.quoteAssetReserve, "10000000000000000000997")
            assert.equal(snapshot.baseAssetReserve, "9999999999999999999")
        })
    
        it("calc MM unrealized PNL/positive", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));
            await exchange.setPriceAdjustRatio(toDecimal("1"))
    
            // long:20 short:45
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            await exchange.moveAMMPriceToOracle(toFullDigit(10), priceFeedKey)
            // baseReserve:100 quoteReserve:1000
            // open-long:250 close-long: 1000 - 100000/120 = 166.67  pnl = -83.33
            // after close long, baseReserve:120 quoteReserve:833.33
            // open-short:450 close-short: 100000/75 - 833.33 = 500.33  pnl = -50.33
            // MMUnrealizedPNL = -(-83.33 + (-50.33)) = 133.33
            reserve = await exchange.getReserve()
            const pnl = await exchange.getMMUnrealizedPNL(reserve[1], reserve[0])
            assert.equal(pnl, "133333333333333333334")
        })
    
        it("calc MM unrealized PNL/negative", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));
            await exchange.setPriceAdjustRatio(toDecimal("1"))
    
            // long:20 short:45
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            await exchange.moveAMMPriceToOracle(toFullDigit(6.2), priceFeedKey)
            const reserve = await exchange.getReserve()
            const pnl = await exchange.getMMUnrealizedPNL(reserve[1], reserve[0])
            assert.equal(pnl, "-7009851223099331388")
        })
    
        it("calc MM unrealized PNL/equal", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));
            await exchange.setPriceAdjustRatio(toDecimal("1"))
    
            // long:20 short:45
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            await exchange.moveAMMPriceToOracle(toFullDigit(6.4), priceFeedKey)
            const reserve = await exchange.getReserve()
            const pnl = await exchange.getMMUnrealizedPNL(reserve[1], reserve[0])
            assert.equal(pnl, "0")
        })
    
        it("shutdown/dont move AMM price", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));

            // long:20 short:45
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
            await exchange.shutdown()
            assert.equal(await exchange.getSettlementPrice(), "8000000000000000000")
            assert.equal(await exchange.open(), false)
        })
    
        it("shutdown/move AMM price, MM PNL is negative, MM liquidity is not enough", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));

            // long:20 short:45  then the price is 6.4
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            // set oracle price to 3
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            const receipt = await exchange.moveAMMPriceToOracle(toFullDigit(3), priceFeedKey)
            expectEvent(receipt, "MoveAMMPrice", {
                ammPrice: toFullDigitStr("6.4"),
                oraclePrice: toFullDigitStr("3"),
                adjustPrice: toFullDigitStr("3"),
                MMLiquidity: toFullDigitStr("10"),
                MMPNL: "-113100842850219755793",
                moved: false
            })
    
            // longPNL: -98  shortPNL: 108  MMPNL: -10
            await exchange.shutdown()
            assert.equal(await exchange.getSettlementPrice(), "8000000000000000000")
            assert.equal(await exchange.open(), false)
        })
    
        it("shutdown/move AMM price, MM PNL is negative, MM liquidity is enough", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));

            // long:20 short:45  then the price is 6.4
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            // set oracle price to 3
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            await this.SakePerpVault.setTotalMMAvailableLiquidity(exchange.address, toDecimal("200"));
            await exchange.moveAMMPriceToOracle(toFullDigit(3), priceFeedKey)
            const reserve = await exchange.getReserve()
            // MMPNL = -113.1  MMLiqidity = 200
            const pnl = await exchange.getMMUnrealizedPNL(reserve[1], reserve[0])
            // console.log(pnl.d)
    
            // longPNL: -180.4  shortPNL: 293.5  MMPNL: -113.1
            await exchange.shutdown()
            assert.equal(await exchange.getSettlementPrice(), "18091097699793355461")
            assert.equal(await exchange.open(), false)
        })
    
        it("shutdown/move AMM price, MM PNL is positive", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));

            // long:20 short:45  then the price is 6.4
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            // set oracle price to 10
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            await exchange.moveAMMPriceToOracle(toFullDigit(8), priceFeedKey)
            // MMPNL = 133.3
            const reserve = await exchange.getReserve()
            const pnl = await exchange.getMMUnrealizedPNL(reserve[1], reserve[0])
            // console.log(pnl.d)
    
            // longPNL: 16.6  shortPNL: -149.9  MMPNL: 133.3
            await exchange.shutdown()
            assert.equal(await exchange.getSettlementPrice(), "4222912360003364857")
            assert.equal(await exchange.open(), false)
        })
    
        it("shutdown/move AMM price, and migrate liquidity", async () => {
            await exchange.setOraclePriceSpreadLimit(toDecimal(1000));

            // long:20 short:45  then the price is 6.4
            await SakePerp.swapInput(Dir.ADD_TO_AMM, toDecimal(250), toDecimal(0))
            await SakePerp.swapInput(Dir.REMOVE_FROM_AMM, toDecimal(450), toDecimal(0))
    
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
    
            // set oracle price to 10
            await exchange.setPriceAdjustRatio(toDecimal("1"))
            await exchange.moveAMMPriceToOracle(toFullDigit(10), priceFeedKey)
            // MMPNL = 244.383107921611923813
            const reserve = await exchange.getReserve()
            const pnl = await exchange.getMMUnrealizedPNL(reserve[1], reserve[0])
            // console.log(pnl.d)
    
            // longPNL: -23.7  shortPNL: -220.6  MMPNL: 244.3
            await exchange.shutdown()
            assert.equal(await exchange.getSettlementPrice(), "7200000000000000000")
            assert.equal(await exchange.open(), false)
        })
    })
})
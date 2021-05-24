const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const IExchange = artifacts.require('IExchange');
const Exchange = artifacts.require('Exchange');
const ExchangeFake = artifacts.require('ExchangeFake');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const L2PriceFeedFake = artifacts.require('L2PriceFeedFake');
const ERC20Token = artifacts.require('ERC20Token');
const InsuranceFund = artifacts.require('InsuranceFund');
const SakePerp = artifacts.require('SakePerp');
const SakePerpFake = artifacts.require('SakePerpFake');
const SakePerpViewer = artifacts.require('SakePerpViewer');
const ExchangeState = artifacts.require('ExchangeState');
const SakePerpVault = artifacts.require('SakePerpVault');
const SakePerpState = artifacts.require('SakePerpState');
const SystemSettings = artifacts.require('SystemSettings');
const TraderWallet = artifacts.require("TraderWallet");
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('../helper/number');
const truffleAssert = require("truffle-assertions");
const { accessSync } = require('fs');
const { utils } = require("ethers")

let DEFAULT_CONTRACT_DEPLOY_ARGS = {
    tradeLimitRatio: floatToDecimal(0.9), // tradeLimitRatio
    spreadRatio:  floatToDecimal(0),
    quoteAssetReserve: toFullDigit(1000),
    baseAssetReserve: toFullDigit(100),
    startSchedule: true,
    fundingPeriod: new BN(86400), // 8hr
    fluctuation: toFullDigit(0),
    priceAdjustRatio: floatToDecimal(0.1), 
}

function floatToDecimal(percent) {
    return { d: toFullDigit(percent * 10000).div(new BN(10000)).toString()}
}
  
function floatToBN(percent) {
    return toFullDigit(percent * 10000).div(new BN(10000))
}
    
function DecimalToFloat(decimal) {
    return new BN(decimal.d).div(new BN(10).pow(new BN(14))).toNumber() / 10000
}

contract("Protocol shutdown test", ([admin, alice, bob, carol, relayer]) => {
    let insuranceFund = null;
    let quoteToken = null;
    let sakePerpViewer = null;
    let exchange = null;
    let mockPriceFeed = null;
    let SakePerp = null;
    let sakePerpVault = null;
    let priceFeed = null;
    let BUY = 0;
    let SELL = 1;
    let Side = {}
    Side.BUY = BUY;
    Side.SELL = SELL;

    let PnlCalcOption = {}
    PnlCalcOption.SPOT_PRICE = 0
    PnlCalcOption.TWAP = 1;

    let Dir = {}
    Dir.ADD_TO_AMM = 0;
    Dir.REMOVE_FROM_AMM = 1;
    const priceFeedKey = "0x0000000000000000000000000000000000000000000000000000000000000001";

    async function approve(account, spender, amount){
        await quoteToken.approve(spender, toFullDigit(amount, +(await quoteToken.decimals())), { from: account })
    }

    async function transfer(from, to, amount){
        await quoteToken.transfer(to, toFullDigit(amount, +(await quoteToken.decimals())), { from })
    }

    
    async function deployAmmPair(quoteToken) {
        const quote = quoteToken || (await ERC20Token.new("Quote Asset Token", "QAT", toFullDigit(1000000000)))
        let exchangeState = await ExchangeState.new();
        const exchange = await ExchangeFake.new(
            DEFAULT_CONTRACT_DEPLOY_ARGS.quoteAssetReserve, 
            DEFAULT_CONTRACT_DEPLOY_ARGS.baseAssetReserve,
            DEFAULT_CONTRACT_DEPLOY_ARGS.tradeLimitRatio.d,
            DEFAULT_CONTRACT_DEPLOY_ARGS.fundingPeriod,
            priceFeed.address,
            SakePerp.address,
            sakePerpVault.address,
            priceFeedKey,
            quote.address,
            DEFAULT_CONTRACT_DEPLOY_ARGS.fluctuation,
            DEFAULT_CONTRACT_DEPLOY_ARGS.priceAdjustRatio.d,
            exchangeState.address
        );
        await exchangeState.initialize(
            exchange.address,
            toFullDigitStr("0"),
            toFullDigitStr("0.05"),
            toFullDigitStr("0.05"),
            toFullDigitStr("0.05"),
            toFullDigitStr("100"),
            toFullDigitStr("0.1"),
        )
        await exchange.fakeInitialize();
        await exchange.setOpen(true);
        await exchange.setCounterParty(SakePerp.address);
        await exchange.setMinter(sakePerpVault.address);
        return { quote, exchange }
    }


    beforeEach(async () => {
        addresses = await web3.eth.getAccounts()
        admin = addresses[0]
        alice = addresses[1]
        bob = addresses[2]
        carol = addresses[3]
        chad = addresses[4]

        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(100), toFullDigitStr(100));
        priceFeed = this.priceFeed
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigit(1000000000));
        this.insuraceFund = await InsuranceFund.new();
        this.SakePerpState = await SakePerpState.new();

        quoteToken = this.quoteAsset;
        
        this.systemSettings = await SystemSettings.new();
        this.SakePerp = await SakePerpFake.new();
        await this.SakePerpState.initialize(this.SakePerp.address, "0");
        this.sakePerpviewer = await SakePerpViewer.new(this.SakePerp.address, this.systemSettings.address);
        this.sakePerpVault = await SakePerpVault.new();
        this.exchangeState = await ExchangeState.new();
        await this.systemSettings.initialize(
            this.SakePerp.address,
            floatToDecimal(0.5).d,
            floatToDecimal(0.005).d,
            floatToDecimal(0.003).d,
            floatToDecimal(0.5).d,
            floatToDecimal(0.5).d,
            86400,
        );

        await this.sakePerpVault.initialize(this.SakePerp.address, this.systemSettings.address);
        await this.SakePerp.initialize(this.systemSettings.address, this.sakePerpVault.address, this.SakePerpState.address);

        this.exchange = await ExchangeFake.new(
            DEFAULT_CONTRACT_DEPLOY_ARGS.quoteAssetReserve, 
            DEFAULT_CONTRACT_DEPLOY_ARGS.baseAssetReserve,
            DEFAULT_CONTRACT_DEPLOY_ARGS.tradeLimitRatio.d,
            DEFAULT_CONTRACT_DEPLOY_ARGS.fundingPeriod,
            this.priceFeed.address,
            this.SakePerp.address,
            this.sakePerpVault.address,
            priceFeedKey,
            this.quoteAsset.address,
            DEFAULT_CONTRACT_DEPLOY_ARGS.fluctuation,
            DEFAULT_CONTRACT_DEPLOY_ARGS.priceAdjustRatio.d,
            this.exchangeState.address
        );
        await this.exchange.fakeInitialize()

        await this.exchangeState.initialize(
            this.exchange.address,
            toFullDigitStr("0"),
            toFullDigitStr("0.05"),
            toFullDigitStr("0.05"),
            toFullDigitStr("0.05"),
            toFullDigitStr("100"),
            toFullDigitStr("0.1"),
        )
        
        await this.insuraceFund.initialize(this.exchange.address, this.sakePerpVault.address);
        await this.exchange.setMover(admin)
        await this.exchange.setExchangeState(this.exchangeState.address)
        await this.exchange.setOpen(true);
        await this.exchange.setCounterParty(this.SakePerp.address);
        await this.exchange.setMinter(this.sakePerpVault.address);
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);

        insuranceFund = this.insuraceFund;
        exchange = this.exchange;
        sakePerpViewer = this.sakePerpviewer;
        SakePerp = this.SakePerp;
        sakePerpVault = this.sakePerpVault;
        mockPriceFeed = this.priceFeed;
    })


    describe("shutdown Exchange test", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));
            
            await transfer(admin, alice, 100)
            await approve(alice, SakePerp.address, 100)
            await transfer(admin, insuranceFund.address, 5000)
        })

        it("close exchange", async () => {
            assert.equal(await exchange.open(), true)
            const receipt = await SakePerp.openPosition(
                exchange.address,
                Side.SELL,
                toDecimal(100),
                toDecimal(2),
                toDecimal(0),
                { from: alice },
            )
            expectEvent(receipt, "PositionChanged")

            await exchange.shutdown()

            assert.equal(await exchange.open(), false)
            assert.equal((await exchange.getSettlementPrice()) != 0, true)

            const error = "exchange was closed"
            await expectRevert(
                SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(0), {
                    from: bob,
                }),
                error,
            )
            await expectRevert(SakePerp.closePosition(exchange.address, toDecimal(0), { from: alice }), error)
            await expectRevert(SakePerp.addMargin(exchange.address, toDecimal(10), { from: alice }), error)
            await expectRevert(SakePerp.removeMargin(exchange.address, toDecimal(10), { from: alice }), error)
            await expectRevert(SakePerp.payFunding(exchange.address, { from: alice }), error)
            await expectRevert(SakePerp.liquidate(exchange.address, alice, { from: carol }), error)
        })

        it("close exchange1 should not affect amm2", async () => {
            // add amm2
            const set2 = await deployAmmPair()
            const amm2 = set2.exchange 
            const quote2 = set2.quote 
            await quote2.transfer(alice, toFullDigit(100))
            await quote2.approve(SakePerp.address, toFullDigit(100), { from: alice })

            let insuraceFund = await InsuranceFund.new();
            await insuraceFund.initialize(amm2.address, this.sakePerpVault.address);
            await this.systemSettings.addExchange(amm2.address, insuraceFund.address);

            // shutdown exchange
            await exchange.shutdown()

            assert.equal((await exchange.open()), false)
            assert.equal((await amm2.open()), true)

            const r = await SakePerp.openPosition(
                amm2.address,
                Side.SELL,
                toDecimal(10),
                toDecimal(2),
                toDecimal(0),
                { from: alice },
            )
            expectEvent(r, "PositionChanged")
        })

        it("settle twice", async () => {
            assert.equal(await exchange.open(), true)
            await SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(0), {
                from: alice,
            })

            await exchange.shutdown()

            const aliceReceipt = await SakePerp.settlePosition(exchange.address, { from: alice })
            await expectEvent.inTransaction(aliceReceipt.tx, quoteToken, "Transfer")
            await expectRevert(SakePerp.settlePosition(exchange.address, { from: alice }), "positionSize is 0")
        })

        it("force error, exchange is open", async () => {
            assert.equal(await exchange.open(),true)
            await SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(0), {
                from: alice,
            })

            await expectRevert(SakePerp.settlePosition(exchange.address, { from: alice }), "exchange is open")
        })

        describe("how much refund trader can get", () => {
            beforeEach(async () => {
                await transfer(admin, bob, 100)
                await approve(bob, SakePerp.address, 100)
                await transfer(admin, carol, 100)
                await approve(carol, SakePerp.address, 100)
            })

            it("get their collateral if settlements price is 0", async () => {
                await SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(0), {
                    from: alice,
                })
                await SakePerp.openPosition(exchange.address, Side.BUY, toDecimal(100), toDecimal(2), toDecimal(0), {
                    from: bob,
                })
                const receipt = await exchange.shutdown()
                await expectEvent.inTransaction(receipt.tx, exchange, "Shutdown", {
                    settlementPrice: "0",
                })

                // then alice get her total collateral
                const aliceReceipt = await SakePerp.settlePosition(exchange.address, { from: alice })
                await expectEvent.inTransaction(aliceReceipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: alice,
                    value: toFullDigit(100, +(await quoteToken.decimals())),
                })

                // then bob get her total collateral
                const bobReceipt = await SakePerp.settlePosition(exchange.address, { from: bob })
                await expectEvent.inTransaction(bobReceipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: bob,
                    value: toFullDigit(100, +(await quoteToken.decimals())),
                })
            })

            it("get trader's collateral back as closing position in average price", async () => {
                await SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(0), {
                    from: alice,
                })
                await SakePerp.openPosition(exchange.address, Side.BUY, toDecimal(100), toDecimal(2), toDecimal(0), {
                    from: bob,
                })
                await SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(1), toDecimal(0), {
                    from: carol,
                })
                const receipt = await exchange.shutdown()
                await expectEvent.inTransaction(receipt.tx, exchange, "Shutdown", {
                    settlementPrice: "8999999999999999999",
                })

                const aliceReceipt = await SakePerp.settlePosition(exchange.address, { from: alice })
                await expectEvent.inTransaction(aliceReceipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: alice,
                    value: "75000000000000000025",
                })

                const bobReceipt = await SakePerp.settlePosition(exchange.address, { from: bob })
                await expectEvent.inTransaction(bobReceipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: bob,
                    value: "124999999999999999975",
                })

                const carolReceipt = await SakePerp.settlePosition(exchange.address, { from: carol })
                await expectEvent.inTransaction(carolReceipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: carol,
                    value: "100000000000000000000",
                })
            })

            // it("get trader's collateral back after migrate liquidity then shutdown exchange and settlement price is 0", async () => {
            //     await SakePerp.openPosition(exchange.address, Side.BUY, toDecimal(100), toDecimal(1), toDecimal(0), {
            //         from: alice,
            //     })
            //     await SakePerp.openPosition(exchange.address, Side.BUY, toDecimal(100), toDecimal(2), toDecimal(0), {
            //         from: bob,
            //     })
            //     await SakePerp.openPosition(exchange.address, Side.SELL, toDecimal(100), toDecimal(1), toDecimal(0), {
            //         from: carol,
            //     })

            //     // after migrate liquidity, total position = 15.151515
            //     await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            //     const totalPositionSize = await exchange.totalPositionSize()
            //     const dir = totalPositionSize.isNeg() ? Dir.REMOVE_FROM_AMM : Dir.ADD_TO_AMM
            //     const totalPositionNotional = await exchange.getOutputPrice(dir, { d: totalPositionSize.toString() })

            //     const chadAmount = utils.formatEther(totalPositionNotional.toString())
            //     await transfer(admin, chad, chadAmount)
            //     await approve(chad, SakePerp.address, chadAmount)

            //     // chad openPosition to make totalPosition = 0
            //     await SakePerp.openPosition(
            //         exchange.address,
            //         Side.SELL,
            //         totalPositionNotional,
            //         toDecimal(1),
            //         toDecimal(0),
            //         {
            //             from: chad,
            //         },
            //     )

            //     const receipt = await exchange.shutdown()
            //     await expectEvent.inTransaction(receipt.tx, exchange, "Shutdown", {
            //         settlementPrice: "0",
            //     })

            //     const aliceReceipt = await SakePerp.settlePosition(exchange.address, { from: alice })
            //     await expectEvent.inTransaction(aliceReceipt.tx, quoteToken, "Transfer", {
            //         from: this.SakePerpVault.address,
            //         to: alice,
            //         value: toFullDigit(100, +(await quoteToken.decimals())),
            //     })

            //     const bobReceipt = await SakePerp.settlePosition(exchange.address, { from: bob })
            //     await expectEvent.inTransaction(bobReceipt.tx, quoteToken, "Transfer", {
            //         from: this.SakePerpVault.address,
            //         to: bob,
            //         value: toFullDigit(100, +(await quoteToken.decimals())),
            //     })

            //     const carolReceipt = await SakePerp.settlePosition(exchange.address, { from: carol })
            //     await expectEvent.inTransaction(carolReceipt.tx, quoteToken, "Transfer", {
            //         from: this.SakePerpVault.address,
            //         to: carol,
            //         value: toFullDigit(100, +(await quoteToken.decimals())),
            //     })

            //     const chadReceipt = await SakePerp.settlePosition(exchange.address, { from: chad })
            //     await expectEvent.inTransaction(chadReceipt.tx, quoteToken, "Transfer", {
            //         from: this.SakePerpVault.address,
            //         to: chad,
            //         value: fromDecimal(totalPositionNotional, +(await quoteToken.decimals())),
            //     })

            //     assert.equal(await quoteToken.balanceOf(SakePerp.address), 0)
            // })
        })
    })
})

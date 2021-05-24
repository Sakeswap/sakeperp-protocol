const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const IExchange = artifacts.require('IExchange');
const Exchange = artifacts.require('Exchange');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const ERC20Token = artifacts.require('ERC20Token');
const InsuranceFund = artifacts.require('InsuranceFund');
const SakePerp = artifacts.require('SakePerp');
const SakePerpState = artifacts.require('SakePerpState');
const SakePerpViewer = artifacts.require('SakePerpViewer');
const SakePerpVault = artifacts.require('SakePerpVault');
const SystemSettings = artifacts.require('SystemSettings');
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('../../helper/number');
const truffleAssert = require("truffle-assertions");
const { latestBlock } = require('@openzeppelin/test-helpers/src/time');

function floatToDecimal(percent) {
  return { d: toFullDigit(percent * 10000).div(new BN(10000)).toString()}
}

function floatToBN(percent) {
    return toFullDigit(percent * 10000).div(new BN(10000))
}
  
function DecimalToFloat(decimal) {
  return new BN(decimal.d).div(new BN(10).pow(new BN(14))).toNumber() / 10000
}

let DEFAULT_CONTRACT_DEPLOY_ARGS = {
    tradeLimitRatio: floatToDecimal(0.9), // tradeLimitRatio
    spreadRatio:  floatToDecimal(0),
    quoteAssetReserve: toFullDigit(1000),
    baseAssetReserve: toFullDigit(100),
    startSchedule: true,
    fundingPeriod: new BN(8 * 60 * 60), // 8hr
    fluctuation: toFullDigit(0),
    priceAdjustRatio: floatToDecimal(0.1), 
}

contract("SakePerp - open/close position Test", ([admin, alice, bob, carol]) => {
    let insuranceFund = null;
    let quoteToken = null;
    let sakePerpViewer = null;
    let exchange = null;
    let sakePerpstate = null;
    let BUY = 0;
    let SELL = 1;
    let Side = {}
    Side.BUY = BUY;
    Side.SELL = SELL;

    let PnlCalcOption = {}
    PnlCalcOption.SPOT_PRICE = 0
    PnlCalcOption.TWAP = 1;

    async function approve(account, spender, amount){
        await quoteToken.approve(spender, toFullDigit(amount, +(await quoteToken.decimals())), { from: account })
    }

    async function transfer(from, to, amount){
        await quoteToken.transfer(to, toFullDigit(amount, +(await quoteToken.decimals())), { from })
    }

    beforeEach(async () => {
        addresses = await web3.eth.getAccounts()
        admin = addresses[0]
        alice = addresses[1]
        bob = addresses[2]
        carol = addresses[3]

        const priceFeedKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10));
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigit(1000000000));
        this.insuraceFund = await InsuranceFund.new();
        this.SakePerpState = await SakePerpState.new();
        this.sakePerp = await SakePerp.new();
        await this.SakePerpState.initialize(this.sakePerp.address, "0");

        quoteToken = this.quoteAsset;
        
        this.systemSettings = await SystemSettings.new();
        await this.systemSettings.initialize(
            this.sakePerp.address,
            floatToDecimal(0.5).d,
            floatToDecimal(0.005).d,
            floatToDecimal(0.003).d,
            floatToDecimal(0.5).d,
            floatToDecimal(0.5).d,
            86400,
        );
        await this.systemSettings.setInsuranceFundFeeRatio(floatToDecimal(0.5));
        await this.systemSettings.setLpWithdrawFeeRatio(floatToDecimal(0.005));

 
        this.sakePerpviewer = await SakePerpViewer.new();
        this.sakePerpVault = await SakePerpVault.new();
        await this.sakePerpVault.initialize(this.sakePerp.address, this.systemSettings.address);
        await this.sakePerp.initialize(this.systemSettings.address, this.sakePerpVault.address, this.SakePerpState.address);
        this.exchange = await Exchange.new();
        this.exchangeState = await ExchangeState.new()
        await this.insuraceFund.initialize(this.exchange.address, this.sakePerpVault.address);

        await this.exchange.initialize(
            DEFAULT_CONTRACT_DEPLOY_ARGS.quoteAssetReserve, 
            DEFAULT_CONTRACT_DEPLOY_ARGS.baseAssetReserve,
            DEFAULT_CONTRACT_DEPLOY_ARGS.tradeLimitRatio.d,
            DEFAULT_CONTRACT_DEPLOY_ARGS.fundingPeriod,
            this.priceFeed.address,
            this.sakePerp.address,
            this.sakePerpVault.address,
            priceFeedKey,
            this.quoteAsset.address,
            DEFAULT_CONTRACT_DEPLOY_ARGS.fluctuation,
            DEFAULT_CONTRACT_DEPLOY_ARGS.priceAdjustRatio.d,
            this.exchangeState.address
        );

        await this.exchangeState.initialize(
            this.exchange.address,
            toFullDigitStr(0),
            toFullDigitStr(0.05),
            toFullDigitStr(0.05),
            toFullDigitStr(0.05),
            toFullDigitStr(100),
            toFullDigitStr(0.1),
        )

        await this.exchange.setOpen(true);
        await this.exchange.setCounterParty(this.sakePerp.address);
        await this.exchange.setMinter(this.sakePerpVault.address);
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);
        await this.sakePerpviewer.initialize(this.sakePerp.address, this.systemSettings.address)

        insuranceFund = this.insuraceFund;
        exchange = this.exchange;
        sakePerpViewer = this.sakePerpviewer;
        sakePerpstate = this.SakePerpState;
        // Each of Alice & Bob have 5000 DAI
        await transfer(admin, alice, 5000)
        await transfer(admin, bob, 5000)
        await transfer(admin, insuranceFund.address, 5000)
    })

    describe("position", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await approve(alice, this.sakePerp.address, 200)
            const sakePerpBaseTokenBalance = await quoteToken.allowance(alice, this.sakePerp.address);
            assert.equal(sakePerpBaseTokenBalance.toString(), toFullDigit(200).toString());
            //expect(sakePerpBaseTokenBalance).eq(toFullDigit(200, +(await quoteToken.decimals()))) 
        })

        it("open position - long", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                from: alice,
            })

            // expect to equal 60
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), toFullDigit(60).toString());
            // personal position should be 37.5
            assert.equal((await this.sakePerp.getPosition(this.exchange.address, alice)).size.toString(), toFullDigit(37.5).toString());
        })

        it("open position - two longs", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)
            // position 1
            // AMM after: 1600:62.5
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // position 2
            // AMM after: 2200:45.454545...
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // total size = 37.5 + 17.045454545 = 54.545454...
            const pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), "54545454545454545454");
            assert.equal(pos.margin.toString(), toFullDigitStr(120));

            const margin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), toFullDigitStr(120));
        })

        it("open position - two shorts", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // create position 1
            // AMM after: 800 : 125
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(40), toDecimal(5), toDecimal(25), {
                from: alice,
            })

            // create position 2
            // AMM after: 600 : 166.6666666667
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(40), toDecimal(5), toDecimal(41.67), {
                from: alice,
            })

            // total size = 25 + 41.6666 = 66.6666... and the size of short position is negative
            const pos2 = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos2.size.toString(), "-66666666666666666667")
            assert.equal(pos2.margin.toString(), toFullDigitStr(80))

            const margin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), toFullDigitStr(80))
        })

        it("open position - two equal size but opposite side positions", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // create position 1
            // AMM after: 1600 : 62.5
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                from: alice,
            })
            // alice has 5000 - 60 = 4940
            assert.equal((await quoteToken.balanceOf(alice)).toString(), (toFullDigit(4940, +(await quoteToken.decimals()))).toString())

            // create position 2
            // AMM after: 1000 : 100
            let ret = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(300),
                toDecimal(2),
                toDecimal(37.5),
                { from: alice },
            )

            const pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), 0)
            assert.equal(pos.margin.toString(), toFullDigit(0))

            const margin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), "0");
        })

        it("open position - one long and two shorts", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // create position 1 - long 60 * 10
            // AMM after: 1600 : 62.5
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                from: alice,
            })

            // create position 2 - short 20 * 5 (reduce position 100)
            // AMM after: 1500 : 66.6666...7
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(5), toDecimal(4.17), {
                from: alice,
            })
            let pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), "33333333333333333333")
            assert.equal(pos.margin.toString(), toFullDigitStr(60))
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), toFullDigitStr(60))

            // create position 3 - short
            // AMM after: 1000 : 100
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(10), toDecimal(33.33), {
                from: alice,
            })
            pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), 0)
            assert.equal(pos.margin.toString(), 0)
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), "0")
        })

        it("open position - short and two longs", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // ## Current Amm Reserves:
            // BaseAsset=1000
            // QuoteAsset=100

            // create position 1 - short 40 * 5
            // AMM after: 800 : 125
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(40), toDecimal(5), toDecimal(25), {
                from: alice,
            })

            // ## POSITION
            // size=-25
            // margin=40
            // openNotional=200
            // #### COSTS
            // - side=1
            // - size=25
            // - quoteAssetReserve=800
            // - baseAssetReserve=125

            //  ## Current Amm Reserves:
            //  BaseAsset=800
            //  QuoteAsset=125

            // create position 2 - long 20 * 5 (reduce position 100)
            // AMM after: 900 : 111.111...2
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(20), toDecimal(5), toDecimal(13.88), {
                from: alice,
            })

            // ## POSITION
            // size=-11.111111111111111111
            // margin=20.000000000000000001
            // openNotional=100
            // #### COSTS
            // - side=1
            // - size=11.111111111111111111
            // - quoteAssetReserve=900
            // - baseAssetReserve=111.111111111111111111
            let pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), "-11111111111111111112")
            assert.equal(pos.margin.toString(), toFullDigitStr(40))
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), toFullDigitStr(40))

            // ## Current Amm Reserves:
            // BaseAsset=900
            // QuoteAsset=111.111111111111111111

            // create position 3 - long
            // AMM after: 1000 : 100
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // there will be 1 wei dust size left
            pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), -1)
            assert.equal(pos.margin.toString(), "39999999999999999993")
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(),
                "39999999999999999993"
            )
        })

        it("open position - short, long and short", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // create position 1 - short
            // AMM after: 800 : 125
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(25), {
                from: alice,
            })

            // create position 2 - long
            // AMM after: 1250: 80
            // return size might loss 1 wei
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(150), toDecimal(3), toDecimal(44.9), {
                from: alice,
            })
            let pos = await this.sakePerp.getPosition(this.exchange.address, alice)

            // sumSize = -25 + 45 = 20
            // expect(pos.size).to.eq(toFullDigit(20))

            // sumMargin = sumNotionalSize((20 * 10) - 150 * 3) / leverage(3) = 83.33
            assert.equal(pos.margin.toString(), "83333333333333333333")
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), "83333333333333333333")

            // create position 3 - short
            // AMM after: 1000 : 100
            // return size might loss 1 wei
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(25), toDecimal(10), toDecimal(19.9), {
                from: alice,
            })
            pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), 0)
            assert.equal(pos.margin.toString(), 0)

            const margin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), 0)

            // 1916.666...7 = 2000 - 83.3333...
            assert.equal((await quoteToken.allowance(alice, this.sakePerp.address)).toString(), "1916666666666666666667")
            assert.equal((await quoteToken.balanceOf(alice)).toString(), (toFullDigit(5000, +(await quoteToken.decimals()))).toString())
        })

        it("open position - long, short and long", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // create position 1 - long
            // AMM after: 1250 : 80
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // create position 2 - short
            // AMM after: 800 : 125
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(150), toDecimal(3), toDecimal(0), {
                from: alice,
            })

            // sumSize = 20 - 45 = -25
            let pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), toFullDigit(-25))

            // sumMargin = sumNotionalSize(250 - 450) / leverage(3) = 66.66
            assert.equal(pos.margin.toString(), "66666666666666666666")
            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), "66666666666666666666")

            // create position 3 - long
            // AMM after: 1000 : 100
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), 0)
            assert.equal(pos.margin.toString(), 0)
            const margin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), 0)
        })

        it("pnl is 0 if no others are trading", async () => {
            await approve(alice, this.sakePerp.address, 1000)
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(250), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(750), toDecimal(1), toDecimal(0), {
                from: alice,
            })

            const pnl = await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)
            assert.equal(pnl.toString(), 0)
        })

        it("close a safe position", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // AMM after 900 : 111.1111...
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(2), toDecimal(11.12), {
                from: alice,
            })
            // personal position should be -11.111...
            assert.equal((await this.sakePerp.getPosition(this.exchange.address, alice)).size, "-11111111111111111112")

            // ## POSITION
            // size=-11.111111111111111111
            // margin=50
            // openNotional=100
            // #### COSTS
            // - side=1
            // - size=11.111111111111111111
            // - quoteAssetReserve=900
            // - baseAssetReserve=111.111111111111111111
            let position = await this.sakePerp.getPosition(this.exchange.address, alice)

            // ## Current Amm Reserves:
            // BaseAsset=900
            // QuoteAsset=111.111111111111111111

            // Then Bob buy 60,  price will increase
            await approve(bob, this.sakePerp.address, 2000)
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(10), toDecimal(6), toDecimal(0), {
                from: bob,
            })
            // base: 900 + 60 = 960, quote: 1000x100 / 960 = 104.166...7
            assert.equal((await exchange.quoteAssetReserve()).toString(), toFullDigit(960).toString())
            assert.equal((await exchange.baseAssetReserve()).toString(), "104166666666666666668")

            // ## Current Amm Reserves:
            // BaseAsset=960
            // QuoteAsset=104.166666666666666666

            /**
             * Now Alice's position is {balance: -11.1111111111, margin: 50, openNotional: 100}
             * if closePosition, it means Alice create a opposite position which is BUY 11.1111111111 quoteAsset
             * (960 + baseAssetAmount) * (104.1666666667 - 11.1111111111) = 1000 * 100 => baseAssetAmount = 114.6268656711
             * Alice will get (100 - 114.6268656711) = -14.6268656711 loss
             * free margin and add profit to Alice's balance
             * all balance = allBalance(2000) + profit(-14.6268656711) = 1985.3731343289
             * margin balance = 0
             * free balance = all balance = 1985.3731343289
             */
            await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // ## POSITION
            // size=0
            // margin=0
            // openNotional=0
            // #### COSTS
            position = await this.sakePerp.getPosition(this.exchange.address, alice)

            assert.equal(position.size.toString(), 0)
            assert.equal((await exchange.quoteAssetReserve()).toString(), "1074626865671641791054")
            assert.equal((await exchange.baseAssetReserve()).toString(), "93055555555555555556")
        })

        it("close a position which is slightly over maintenanceMarginRatio", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // AMM after 1250 : 80...
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // personal position should be 20
            assert.equal((await this.sakePerp.getPosition(this.exchange.address, alice)).size.toString(), toFullDigit(20).toString())

            // Then Bob short 35.08,  price will decrease
            // AMM after 1214.92 : 82.31
            await approve(bob, this.sakePerp.address, 2000)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(35.08), toDecimal(1), toDecimal(0), {
                from: bob,
            })

            /**
             * Now Alice's position is {margin: 25}
             * positionValue of 20 quoteAsset is 237.5 now
             * marginRatio = (margin(25) + unrealizedPnl(237.5-250)) / openNotionalSize(250) = 5%
             */
            await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // AMM after 977.42 : 102.31
            // Alice's realizedPnl = 237.5 - 250 = -12.5
            // balance = approved(2000) + realizedPnl(-12.5) = 1987.5
            const position = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(position.size.toString(), "0")
            assert.equal((await exchange.quoteAssetReserve()), "977422074620429546963")
            assert.equal((await exchange.baseAssetReserve()), "102309946333914990288")
            const margin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)

            assert.equal(margin.toString(), "0")
        })

        it("close a under collateral position", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // AMM after 1250 : 80...
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // personal position should be 20
            assert.equal((await this.sakePerp.getPosition(this.exchange.address, alice)).size.toString(), toFullDigit(20).toString())

            // Then Bob short 250,  price will decrease
            await approve(bob, this.sakePerp.address, 2000)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(250), toDecimal(1), toDecimal(0), {
                from: bob,
            })

            /**
             * Now Alice's position is {balance: 20, margin: 25}
             * positionValue of 20 quoteAsset is 166.67 now
             * marginRatio = (margin(25) + unrealizedPnl(166.67-250)) / openNotionalSize(250) = -23%
             */
            await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // Alice's realizedPnl = 166.66 - 250 = -83.33, she lost all her margin(25)
            // alice.balance = all(5000) - margin(25) = 4975
            // insuranceFund.balance = 5000 + realizedPnl(-58.33) = 4941.66...
            // this.sakePerp.balance = 250 + +25 + 58.33(pnl from insuranceFund) = 333.33
            const position = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(position.size.toString(), "0")
            const alicemargin = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(
                quoteToken.address,
                alice,
            )
            assert.equal(alicemargin.toString(), "0")
            const aliceBalance = await quoteToken.balanceOf(alice)
            assert.equal(aliceBalance.toString(), (toFullDigit(4975, +(await quoteToken.decimals()))).toString())
            let insuranceFundBalance = await quoteToken.balanceOf(insuranceFund.address)
            assert.equal(insuranceFundBalance.toString(), "4941666666666666666666")
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(), "10333333333333333333334")
        })

        it("close an empty position", async () => {
            await expectRevert(
                this.sakePerp.closePosition(this.exchange.address, toDecimal(0), {
                    from: alice,
                }),
                "positionSize is 0",
            )
        })

        it("open/close position to check the fee is charged", async () => {
            await this.exchangeState.setSpreadRatio(toDecimal(0.02))

            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            let spreadFee = 60 * 10 * (0.02)
            let insuranceFundFee = spreadFee / 2
            let vaultFee = spreadFee / 2

            //10000的LP加的 60trader开仓的
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(), 
                toFullDigit(10060 + vaultFee, +(await quoteToken.decimals())).toString(),
            )


            await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(),
                toFullDigit(10000 + vaultFee + vaultFee, +(await quoteToken.decimals())).toString(),
            )
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(),
                toFullDigit(5000 + insuranceFundFee + insuranceFundFee, +(await quoteToken.decimals())).toString(),
            )

            //expect(await stakingReserve.feeMap(quoteToken.address)).eq(toFullDigit(12))
        })
        

        it("check PositionChanged event by opening and then closing a position", async () => {
            // deposit to 2000
            await this.exchangeState.setSpreadRatio(toDecimal(0.01))
            await approve(alice, this.sakePerp.address, 2000)

            // AMM after 900 : 111.1111...
            const receiptOpen = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(50),
                toDecimal(2),
                toDecimal(11.12),
                { from: alice },
            )

            await expectEvent.inTransaction(receiptOpen.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                margin: toFullDigit(50),
                positionNotional: toFullDigit(100),
                exchangedPositionSize: "-11111111111111111112",
                fee: toFullDigit(1), // notional size 100 * 1% = 1
                positionSizeAfter: "-11111111111111111112",
                realizedPnl: "0",
            })

            const receiptClose = await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })
            await expectEvent.inTransaction(receiptClose.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                margin: "0",
                positionNotional: "100000000000000000008",
                exchangedPositionSize: "11111111111111111112",
                fee: "1000000000000000000",
                positionSizeAfter: toFullDigit(0),
            })

            const position = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(position.size.toString(), "0")
        })
   
        it("check PositionChanged event by open 2 opposite side positions with the same size", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // AMM after 900 : 111.1111...
            const receiptOpen = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(50),
                toDecimal(2),
                toDecimal(11.12),
                { from: alice },
            )
            await expectEvent.inTransaction(receiptOpen.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(100),
                exchangedPositionSize: "-11111111111111111112",
                fee: toFullDigit(0),
                positionSizeAfter: "-11111111111111111112",
                realizedPnl: "0",
            })

            const amount = await exchange.getOutputPrice(1, { d: "11111111111111111111" })

            const receiptOpen2 = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                amount,
                toDecimal(1),
                toDecimal(0),
                { from: alice },
            )

            await expectEvent.inTransaction(receiptOpen2.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: amount.d,
                exchangedPositionSize: "11111111111111111111",
                fee: toFullDigit(0),
                positionSizeAfter: "-1",
            })
        })

        it("check PositionChanged event by open a smaller opposite side position", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // AMM after 900 : 111.1111...
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(2), toDecimal(11.12), {
                from: alice,
            })

            const receiptOpen2 = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(50),
                toDecimal(1),
                toDecimal(0),
                { from: alice },
            )

            await expectEvent.inTransaction(receiptOpen2.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                fee: toFullDigit(0),
                positionSizeAfter: "-5263157894736842107",
            })
        })

        it("check exchangedPositionSize in PositionChanged event by opening a lager reverse long", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // got -11.11 position size
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(2), toDecimal(11.12), {
                from: alice,
            })

            // got 24.155 position size
            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(50),
                toDecimal(5),
                toDecimal(0),
                { from: alice },
            )

            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                positionNotional: toFullDigit(250),
                exchangedPositionSize: "24154589371980676328",
                positionSizeAfter: "13043478260869565216",
            })
        })

        it("check exchangedPositionSize in PositionChanged event by opening a lager reverse short", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)

            // got 9.09 position size
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(50), toDecimal(2), toDecimal(0), {
                from: alice,
            })

            // got -26.738 position size
            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(50),
                toDecimal(5),
                toDecimal(0),
                { from: alice },
            )

            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                positionNotional: toFullDigit(250),
                exchangedPositionSize: "-26737967914438502674",
                positionSizeAfter: "-17647058823529411765",
            })
        })

        it.skip("alice open position, bob open another position, alice reduce position and update margin by closedPnl", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)
            await approve(bob, this.sakePerp.address, 2000)

            // alice trade 37.5 contract for 60 * 10 quoteToken
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                from: alice,
            })
            // bob trade 12.5 contract for 40 * 10 quoteToken
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(40), toDecimal(10), toDecimal(12.5), {
                from: bob,
            })

            // now alice has unrealizedPnl 257.14
            // then alice reduce position for 400 quoteToken (equals to 12.5 contract)
            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(400),
                toDecimal(1),
                toDecimal(12.5),
                {
                    from: alice,
                },
            )

            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(400),
                exchangedPositionSize: toFullDigit(-12.5),
                fee: toFullDigit(0),
                positionSizeAfter: toFullDigit(25),
                realizedPnl: "0",
                badDebt: "0",
            })

            // because her marginRatio is high enough that she doesn't need to keep any margin
            const balance = await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            expect(balance).eq(toFullDigit(0))
        })

        it.skip("alice open position, bob open another position, alice open reverse position with larger size")

        it("pnl - unrealized", async () => {
            console.log(await this.exchange.reserveSnapshots(0));

            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)
            await approve(bob, this.sakePerp.address, 2000)
            // Alice's Balance in this.sakePerp: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice long by 25 base token with leverage 10x to get 20 ptoken
            // 25 * 10 = 250 which is x
            // (1000 + 250) * (100 + y) = 1000 * 100
            // so y = -20
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // Bob's balance in this.sakePerp: 2000
            // current equation is:
            // (1250 + x) * (80 + y) = 1000 * 100
            // Bob short by 100 base token with leverage 10x to get -320 ptoken
            // 100 * 10 = 1000 which is x
            // (1250 - 1000) * (80 + y) = 1000 * 100
            // so y = 320
            //
            // and current equation is :
            // (250 + x) * (400 + y) = 1000 * 100
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(100), toDecimal(10), toDecimal(320), {
                from: bob,
            })

            const pos = await this.sakePerp.getPosition(this.exchange.address, alice)
            assert.equal(pos.size.toString(), toFullDigit(20).toString())

            // calculate Alice's unrealized PNL:
            // Alice has position 20 ptoken, so
            // (250 + x) * (400 + 20) = 1000 * 100
            // x = -11.9047619048
            // alice will get 11.9047619048 if she close position
            // since Alice use 250 to buy
            // 11.9047619048 - 250 = -238.0952380952 which is unrealized PNL.
            const alicePnl = await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)
            assert.equal(alicePnl.toString(), "-238095238095238095239")
        })

        it("Force error, open position - not enough balance", async () => {
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(600), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(4401), toDecimal(10), toDecimal(0), {
                    from: alice,
                }),
                "ERC20: transfer amount exceeds allowance",
            )
        })

        it("Force error, open position - exceed margin ratio", async () => {
            await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(60), toDecimal(21), toDecimal(37.5), {
                    from: alice,
                }),
                "Margin ratio not meet criteria",
            )
        })

        it("alice take profit from bob's unrealized under-collateral position, then bob close", async () => {
            // alice opens short position
            await approve(alice, this.sakePerp.address, 20)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // bob opens short position
            await approve(bob, this.sakePerp.address, 20)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // alice close position, pnl = 200 -105.88 ~= 94.12
            // receive pnl + margin = 114.12
            const aliceReceipt = await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // depositPool only has 40, ask insuranceFund to pre-pay extra badDebt 114.12 - 40 = 74.12
            await expectEvent.inTransaction(aliceReceipt.tx, quoteToken, "Transfer", {
                from: this.sakePerpVault.address,
                to: alice,
                value: "114117647058823529412",
            })
            assert.equal((await quoteToken.balanceOf(this.sakePerp.address)).toString(), "0")

            // bob close her under collateral position, positionValue is -294.11
            // bob's pnl = 200 - 294.11 ~= -94.12
            // bob loss all her margin (20) with additional 74.12 badDebt
            // which is already prepaid by insurance fund when alice close the position before
            // clearing house don't need to ask insurance fund for covering the bad debt
            const bobMarginRatio = await this.sakePerp.getMarginRatio(this.exchange.address, bob)
            assert.equal((new BN(bobMarginRatio.d).isNeg()), true)
            await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: bob })

            // this.sakePerp is depleted
            assert.equal((await quoteToken.balanceOf(this.sakePerp.address)), "0")
        })

        it("alice take profit from bob's unrealized under-collateral position, then bob got liquidate", async () => {
            // alice opens short position
            await approve(alice, this.sakePerp.address, 20)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // bob opens short position
            await approve(bob, this.sakePerp.address, 20)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // alice close position, pnl = 200 -105.88 ~= 94.12
            // receive pnl + margin = 114.12
            const aliceReceipt = await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // depositPool only has 40, ask insuranceFund to pre-pay extra badDebt 114.12 - 40 = 74.12
            await expectEvent.inTransaction(aliceReceipt.tx, quoteToken, "Transfer", {
                from: this.sakePerpVault.address,
                to: alice,
                value: "114117647058823529412",
            })
            assert.equal((await quoteToken.balanceOf(this.sakePerp.address)).toString(), "0")
            //assert.equal((await this.sakePerp.getPrepaidBadDebt(quoteToken.address)).toString(), "74117647058823529412")

            // keeper liquidate bob's under collateral position, bob's positionValue is -294.11
            // bob's pnl = 200 - 294.11 ~= -94.12
            // bob loss all her margin (20) and there's 74.12 badDebt
            // which is already prepaid by insurance fund when alice close the position
            const bobMarginRatio = await this.sakePerp.getMarginRatio(this.exchange.address, bob)
            assert.equal((new BN(bobMarginRatio.d).isNeg()), true)
            console.log((await quoteToken.balanceOf(carol)).toString());
            await this.sakePerp.liquidate(this.exchange.address, bob, { from: carol })

            // liquidator get 5% liquidation fee = 294.11 * 5% ~= 14.7
            // this.sakePerp is depleted
            assert.equal((await quoteToken.balanceOf(this.sakePerp.address)).toString(), "0")
            assert.equal((await quoteToken.balanceOf(carol)).toString(), "14705882352941176470")
        })

        it("alice's position got liquidated and not enough margin left for paying liquidation fee", async () => {
            // alice opens long position
            await approve(alice, this.sakePerp.address, 150)
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(150), toDecimal(4), toDecimal(0), {
                from: alice,
            })

            // bob opens short position
            await approve(bob, this.sakePerp.address, 500)
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(500), toDecimal(1), toDecimal(0), {
                from: bob,
            })

            // alice's margin ratio = (margin + unrealizedPnl) / openNotional = (150 + (-278.77)) / 600 = -21.46%
            const receipt = await this.sakePerp.liquidate(this.exchange.address, alice, { from: carol })

            // liquidationFee = 321.23 * 5% = 16.06
            // remainMargin = margin + unrealizedPnl = 150 + (-278.77) = -128.77
            // Since -128.77 - 16.06 < 0
            //   position changed badDebt = 128.77
            //   liquidation badDebt = 16.06
            // Trader total PnL = -278.77 + 128.77 = -150

            expectEvent(receipt, "PositionChanged", {
                realizedPnl: "-278761061946902654868",
                badDebt: "128761061946902654868",
                liquidationPenalty: "0",
            })
            expectEvent(receipt, "PositionLiquidated", {
                liquidationFee: "16061946902654867256",
                badDebt: "16061946902654867256",
            })
        })

        it("force error, can NOT open a long/short position when position(long) is under collateral", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)
            await approve(bob, this.sakePerp.address, 2000)

            // AMM after 1250 : 80...
            // position 20
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // Then Bob short 250,  price will decrease
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(250), toDecimal(1), toDecimal(0), {
                from: bob,
            })

            /**
             * Now Alice's position is {balance: 20, margin: 25}
             * positionValue of 20 quoteAsset is 166.67 now
             * marginRatio = (margin(25) + unrealizedPnl(166.67-250)) / openNotionalSize(250) = -23%
             */
            await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(1), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "Margin ratio not meet criteria",
            )

            await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(1), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "Margin ratio not meet criteria",
            )
        })

        it("force error, can NOT open a long/short position when position(short) is under collateral", async () => {
            // deposit to 2000
            await approve(alice, this.sakePerp.address, 2000)
            await approve(bob, this.sakePerp.address, 2000)

            // AMM after 125 : 80...
            // position 25
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // Now Alice's position is underwater, cant increase position
            await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(1), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "Margin ratio not meet criteria",
            )
        })
    })

    describe("position upper bound", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, toDecimal(10000));

            await this.exchangeState.setCap(toDecimal(10), toDecimal(0))
            await approve(alice, this.sakePerp.address, 1000)
        })

        it("open a long and a smaller short position under limit", async () => {
            // position size is 9.9
            const r = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(110),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")

            const r2 = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(50),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r2.tx, this.sakePerp, "PositionChanged")
        })

        it("open two long positions under limit", async () => {
            const r = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(55),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")

            const r2 = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(55),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r2.tx, this.sakePerp, "PositionChanged")
        })

        it("open a short position and a smaller long under limit", async () => {
            // position size is -9.89
            const r = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(90),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")

            const r2 = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(50),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r2.tx, this.sakePerp, "PositionChanged")
        })

        it("open two short positions under limit", async () => {
            const r = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(45),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")

            const r2 = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(45),
                toDecimal(1),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r2.tx, this.sakePerp, "PositionChanged")
        })

        it("change position size upper bound and open positions", async () => {
            await this.exchangeState.setCap(toDecimal(20), toDecimal(0))

            // position size is 20
            const r = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(25),
                toDecimal(10),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")
            await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // position size is -19.05
            const r2 = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(16),
                toDecimal(10),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            expectEvent.inTransaction(r2.tx, this.sakePerp, "PositionChanged")
        })

        it("force error, open a long position and over the limit", async () => {
            // position size is 10.7
            const r = await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(120), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "hit position size upper bound",
            )
        })

        it("force error, open long positions and over the limit", async () => {
            // position size is 10.7
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(1), toDecimal(0), {
                from: alice,
            })

            const r = await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(60), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "hit position size upper bound",
            )
        })

        it("force error, open a short position and over the limit", async () => {
            // position size is -10.5
            const r = await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(95), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "hit position size upper bound",
            )
        })

        it("force error, open short positions and over the limit", async () => {
            // position size is -10.5
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(45), toDecimal(1), toDecimal(0), {
                from: alice,
            })

            const r = await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "hit position size upper bound",
            )
        })

        it("force error, open a long and a larger reverse short and over the limit", async () => {
            // position size is 9.09
            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // position size would be -10.2, revert
            const r = await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                    from: alice,
                }),
                "hit position size upper bound",
            )
        })

        it("force error, open a short and a larger reverse long and over the limit", async () => {
            // position size is -9.89
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(9), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // position size would be 10.7, revert
            const r = await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(21), toDecimal(10), toDecimal(0), {
                    from: alice,
                }),
                "hit position size upper bound",
            )
        })

        describe("whitelisting", () => {
            it("add whitelists, and open a long which larger than the limit", async () => {
                await sakePerpstate.setWhitelist(alice)

                // position size is 10.7
                const r = await this.sakePerp.openPosition(
                    this.exchange.address,
                    BUY,
                    toDecimal(120),
                    toDecimal(1),
                    toDecimal(0),
                    { from: alice },
                )
                await expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")
            })

            it("add whitelists, and open a short, a larger reverse long", async () => {
                await sakePerpstate.setWhitelist(alice)
                // position size is -9.89
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(9), toDecimal(10), toDecimal(0), {
                    from: alice,
                })

                // position size would be 10.7, revert
                const r = await this.sakePerp.openPosition(
                    this.exchange.address,
                    BUY,
                    toDecimal(21),
                    toDecimal(10),
                    toDecimal(0),
                    { from: alice },
                )
                await expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")
            })

            it("remove from whitelist, open a long and a larger reverse short", async () => {
                await sakePerpstate.setWhitelist(alice)
                // position size is 10.7
                await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(120), toDecimal(1), toDecimal(0), {
                    from: alice,
                })

                await sakePerpstate.setWhitelist("0x0000000000000000000000000000000000000000")
                // position size would be -14.9, revert
                const r = await expectRevert(
                    this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(25), toDecimal(10), toDecimal(0), {
                        from: alice,
                    }),
                    "hit position size upper bound",
                )
            })

            it("remove from whitelist and add back", async () => {
                await sakePerpstate.setWhitelist(alice)
                // position size is 10.7
                await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(120), toDecimal(1), toDecimal(0), {
                    from: alice,
                })

                await sakePerpstate.setWhitelist("0x0000000000000000000000000000000000000000")
                // position size would be -14.9, revert
                await expectRevert(
                    this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(25), toDecimal(10), toDecimal(0), {
                        from: alice,
                    }),
                    "hit position size upper bound",
                )

                await sakePerpstate.setWhitelist(alice)
                const r = await this.sakePerp.openPosition(
                    this.exchange.address,
                    SELL,
                    toDecimal(25),
                    toDecimal(10),
                    toDecimal(0),
                    { from: alice },
                )
                await expectEvent.inTransaction(r.tx, this.sakePerp, "PositionChanged")
            })
        })
    })

    //pass
    describe("fee calculation", () => {
        beforeEach(async () => {
            await this.exchangeState.setSpreadRatio(toDecimal(0.05))
            await this.exchangeState.setCap(toDecimal(0), toDecimal(0))

            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, toDecimal(10000));
        })

        it("open position when total fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 360)

            // given 300 x 2 quote asset, get 37.5 base asset
            // fee is 300 x 2 x 10% = 60
            // user needs to pay 300 + 60 = 360
            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(300),
                toDecimal(2),
                toDecimal(37.5),
                {
                    from: alice,
                },
            )
            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(600), // 300x2
                exchangedPositionSize: toFullDigit(37.5),
                fee: toFullDigit(30),
                positionSizeAfter: toFullDigit(37.5),
                realizedPnl: "0",
            })

            assert.equal((await this.sakePerpviewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(300).toString()
            )
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(),
                toFullDigit(10315, +(await quoteToken.decimals())).toString()
            )

            // fee 30, spread 30
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(), 
                toFullDigit(5015, +(await quoteToken.decimals())).toString(),
            )
        })

        it("open short position twice when total fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 360)

            // given 50 x 2 quote asset, get 11.1 base asset
            // fee is 50 x 2 x 10% = 10
            // user needs to pay 50 + 10 = 60
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(2), toDecimal(11.2), {
                from: alice,
            })
            const aliceBalance1 = await quoteToken.balanceOf(alice)

            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                toDecimal(50),
                toDecimal(2),
                toDecimal(139),
                { from: alice },
            )
            const aliceBalance2 = await quoteToken.balanceOf(alice)
            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(100),
                exchangedPositionSize: "-13888888888888888889",
                fee: toFullDigit(5),
                positionSizeAfter: "-25000000000000000001",
                realizedPnl: "0",
            })
            assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), toFullDigit(-55, +(await quoteToken.decimals())).toString())

            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(),
                toFullDigit(10105, +(await quoteToken.decimals())).toString(),
            )
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(), 
                toFullDigit(5005, +(await quoteToken.decimals())).toString(),
            )
        })

        it("open and close position when total fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 2000)

            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(300), toDecimal(2), toDecimal(37.5), {
                from: alice,
            })

            // when alice close her entire position
            const receipt = await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })

            // then 37.5 contract worth 600 quoteAsset (openNotional doesn't change because no other trade)
            // strike will take fees after traded with exchange, fee = 600 * 10% = 60
            // alice actual get 600 - 60 = 540 when closing her entire 37.5 position
            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(600),
                exchangedPositionSize: toFullDigit(-37.5),
                fee: toFullDigit(30),
                positionSizeAfter: toFullDigit(0),
                realizedPnl: "0",
            })

            // feePool = 60 (fee of opening the position) + 60 (fee of closing the position)
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(),
                toFullDigit(10030, +(await quoteToken.decimals())).toString()
            )
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(),
                toFullDigit(5030, +(await quoteToken.decimals())).toString()
            )
        })

        it("open position and close manually by opening reverse position(long then short) when fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 420)

            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(300), toDecimal(2), toDecimal(0), {
                from: alice,
            })

            const positionNotional = (
                await this.sakePerp.getPositionNotionalAndUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)
            )[0]

            // alice need 600 to close her 37.5 position, she opens a reverse position to close manually
            // and she doesn't need to increase quoteToken's balance or allowance
            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                SELL,
                { d: positionNotional.toString() },
                toDecimal(1),
                toDecimal(0),
                { from: alice },
            )

            // then 37.5 contract worth 600 quoteAsset (openNotional doesn't change because no other trade)
            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(600),
                exchangedPositionSize: toFullDigit(-37.5),
                fee: toFullDigit(30),
                positionSizeAfter: toFullDigit(0),
                realizedPnl: "0",
            })

            // 1st tx fee = 300 * 2 * 5% = 30
            // 1st tx spread = 300 * 2 * 5% = 30
            // 2nd tx fee = 300 * 2 * 5% = 30
            // 2nd tx fee = 300 * 2 * 5% = 30
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(),
                toFullDigit(5030, +(await quoteToken.decimals())).toString(),
            )
        })

        //NEED DO!!
        // it("open position and close manually by opening reverse position(short then long) when fee is 10%", async () => {
        //     await approve(alice, this.sakePerp.address, 420)

        //     await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(300), toDecimal(2), toDecimal(0), {
        //         from: alice,
        //     })

        //     // const positionNotional = (
        //     //     await this.sakePerp.getPositionNotionalAndUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)
        //     // )[0]

        //     let positionNotional = "600000000000000000000";
        //     console.log(positionNotional.toString())
        //     // alice need 600 to close her 37.5 position, she opens a reverse position to close manually
        //     // and she doesn't need to increase quoteToken's balance or allowance
        //     const receipt = await this.sakePerp.openPosition(
        //         this.exchange.address,
        //         BUY,
        //         { d: positionNotional.toString() },
        //         toDecimal(1),
        //         toDecimal(0),
        //         { from: alice },
        //     )

        //     // then 37.5 contract worth 600 quoteAsset (openNotional doesn't change because no other trade)
        //     await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
        //         trader: alice,
        //         exchange: this.exchange.address,
        //         positionNotional: toFullDigit(600),
        //         exchangedPositionSize: toFullDigit(150),
        //         fee: toFullDigit(30),
        //         positionSizeAfter: toFullDigit(0),
        //         realizedPnl: "0",
        //     })

        //     // 1st tx fee = 300 * 2 * 5% = 30
        //     // 1st tx spread = 300 * 2 * 5% = 30
        //     // 2nd tx fee = 300 * 2 * 5% = 30
        //     // 2nd tx fee = 300 * 2 * 5% = 30
        //     expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(
        //         toFullDigit(5030, +(await quoteToken.decimals())),
        //     )
        // })

        it("close a under collateral position when fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 60) // 20(first margin) + 20(open fee) + 17.04(close fee)
            await approve(bob, this.sakePerp.address, 2000)

            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // bob short position to let Alice PnL is negative
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // alice PnL is -29.577464788732394365
            // closed notional size = 200 - 29.577 = 170.422
            // fee would be 170.422 * 10% = 17.04
            const receipt = await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice })
        })

        it("force error, close a under collateral position when fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 57) // need 20(first margin) + 20(open fee) + 17.04(close fee)
            await approve(bob, this.sakePerp.address, 2000)

            await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // bob short position to let Alice PnL is negative
            await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // alice PnL is -29.577464788732394365
            // closed notional size = 200 - 29.577 = 170.422
            // fee would be 170.422 * 10% = 17.04
            // await expectRevert(
            //     this.sakePerp.closePosition(this.exchange.address, toDecimal(0), { from: alice }),
            //     "DecimalERC20: transferFrom failed",
            // )
        })

        it("force error, not enough balance to open position when total fee is 10%", async () => {
            await approve(alice, this.sakePerp.address, 100)

            // given 300 x 2 quote asset, get 37.5 base asset
            // fee is 300 x 2 x 10% = 60
            // user needs to pay 300 + 60 = 360, but only has 359
            await expectRevert(
                this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(300), toDecimal(2), toDecimal(37.5), {
                    from: alice,
                }),
                "ERC20: transfer amount exceeds allowance",
            )
        })

        it("has spread but no toll", async () => {
            await this.exchangeState.setSpreadRatio(toDecimal(0.1))

            await approve(alice, this.sakePerp.address, 360)
            const receipt = await this.sakePerp.openPosition(
                this.exchange.address,
                BUY,
                toDecimal(300),
                toDecimal(2),
                toDecimal(0),
                {
                    from: alice,
                },
            )
            await expectEvent.inTransaction(receipt.tx, this.sakePerp, "PositionChanged", {
                trader: alice,
                exchange: this.exchange.address,
                positionNotional: toFullDigit(600), // 300x2
                exchangedPositionSize: toFullDigit(37.5),
                fee: toFullDigit(60),
                positionSizeAfter: toFullDigit(37.5),
                realizedPnl: "0",
            })

            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(),
                toFullDigit(5030, +(await quoteToken.decimals())).toString(),
            )
        })
    })

    
    describe("traded with 10% fee exchange, check size, margin and openNotional", () => {
        beforeEach(async () => {
            // unlock alice and bob's quoteToken for this.sakePerp (this.sakePerp)
            
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, toDecimal(10000));

            await approve(alice, this.sakePerp.address, "1000000")
            await approve(bob, this.sakePerp.address, "1000000")

            // 10% fee
            await this.exchangeState.setSpreadRatio(toDecimal(0.1))
            await this.exchangeState.setCap(toDecimal(0), toDecimal(0))
        })

        //pass
        describe("open position", () => {
            it("open long position", async () => {
                // alice opens long position with 60 margin, 10x leverage
                // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(37.5),
                    {
                        from: alice,
                    },
                )

                // transferred margin = margin + fee = 60 + (60 * 10 * 10%) = 120
                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal((position.size).toString(), toFullDigit(37.5).toString())
                assert.equal((position.openNotional).toString(), toFullDigit(600).toString())
                assert.equal((position.margin).toString(), toFullDigit(60).toString())

                assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(), 
                    toFullDigit(10090, +(await quoteToken.decimals())).toString(),
                )
            })

            it("open short position", async () => {
                // alice opens short position with 60 margin, 10x leverage
                // (1000 - 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 150
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    SELL,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(150),
                    {
                        from: alice,
                    },
                )

                // transferred margin = margin + fee = 60 + (60 * 10 * 10%) = 120
                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal(position.size.toString(), toFullDigit(-150).toString())
                assert.equal(position.openNotional.toString(), toFullDigit(600).toString())
                assert.equal(position.margin.toString(), toFullDigit(60).toString())

                assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(),
                    toFullDigit(10090, +(await quoteToken.decimals())).toString(),
                )
            })
        })

        //pass
        describe("increase position", () => {
            it("open long position, price remains, then long again", async () => {
                // alice opens long position with 25 margin, 10x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // alice opens long position with 175 margin, 2x leverage
                // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    BUY,
                    toDecimal(175),
                    toDecimal(2),
                    floatToDecimal(17.5),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // transferred margin = margin + fee = 175 + (175 * 2 * 10%) = 210
                assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), toFullDigit(-210, +(await quoteToken.decimals())).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 20 + 17.5 = 37.5
                assert.equal((position.size).toString(), floatToBN(37.5).toString())
                // open notional = 250 + 350 = 600
                assert.equal((position.openNotional).toString(), toFullDigit(600).toString())
                // total position margin = 25 + 175 = 200
                assert.equal((position.margin).toString(), toFullDigit(200).toString())
                // pnl = 0 because no other trader
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "0")
            })

            it("open long position, price up, then long again", async () => {
                // alice opens long position with 25 margin, 10x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens long position with 35 margin, 10x leverage, price up
                // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
                await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(35), toDecimal(10), toDecimal(17.5), {
                    from: bob,
                })

                // alice's 20 long position worth 387.88 now
                // (1600 + quoteAssetDelta) * (62.5 + 20) = 100k, quoteAssetDelta = -387.878787878787878787
                // unrealizedPnl = positionNotional - cost = 387.878787878787878787 - 250 = 137.878787878787878787
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "137878787878787878787",
                )

                // alice opens long position with 200 margin, 2x leverage
                // (1600 + 400) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.BUY,
                    toDecimal(200),
                    toDecimal(2),
                    toDecimal(12.5),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // transferred margin = margin + fee = 200 + (200 * 2 * 10%) = 240
                assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), toFullDigit(-240, +(await quoteToken.decimals())).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 20 + 12.5 = 32.5
                assert.equal((position.size).toString(), toFullDigit(32.5).toString())
                // open notional = 250 + 400 = 650
                assert.equal((position.openNotional).toString(), toFullDigit(650).toString())
                // total position margin = 25 + 200 = 225
                assert.equal((position.margin).toString(), toFullDigit(225).toString())
            })

            it("open long position, price down, then long again", async () => {
                // alice opens long position with 125 margin, 2x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(125), toDecimal(2), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens short position with 125 margin, 2x leverage, price down
                // (1250 - 250) * (80 + baseAssetDelta) = 100k, baseAssetDelta = 20
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(125), toDecimal(2), toDecimal(20), {
                    from: bob,
                })

                // alice's 20 long position worth 166.67 now
                // (1000 + quoteAssetDelta) * (100 + 20) = 100k, quoteAssetDelta = -166.666666666666666666
                // unrealizedPnl = positionValue - cost = 166.666666666666666666 - 250 = -83.333333333333333333
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-83333333333333333334",
                )

                // alice opens long position with 50 margin, 5x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    BUY,
                    toDecimal(50),
                    toDecimal(5),
                    toDecimal(20),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // transferred margin = margin + fee = 50 + (50 * 5 * 10%) = 75
                assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), toFullDigit(-75, +(await quoteToken.decimals())).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 20 + 20 = 40
                assert.equal((position.size).toString(), toFullDigit(40).toString())
                // open notional = 250 + 250 = 500
                assert.equal((position.openNotional).toString(), toFullDigit(500).toString())
                // total position margin = 125 + 50 = 175
                assert.equal((position.margin).toString(), toFullDigit(175).toString())
            })

            it("open short, price remains, then short again", async () => {
                // alice opens short position with 100 margin, 2x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(100), toDecimal(2), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // alice opens short position with 50 margin, 8x leverage
                // (800 - 400) * (125 + baseAssetDelta) = 100k, baseAssetDelta = 125
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(50),
                    toDecimal(8),
                    toDecimal(125),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // then transferred margin = margin + fee = 50 + (50 * 8 * 10%) = 90
                assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), toFullDigit(-90, +(await quoteToken.decimals())).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = -25 + -125 = -150
                assert.equal((position.size).toString(), toFullDigit(-150).toString())
                // open notional = 200 + 400 = 600
                assert.equal((position.openNotional).toString(), toFullDigit(600).toString())
                // total position margin = 100 + 50 = 150
                assert.equal((position.margin).toString(), toFullDigit(150).toString())
                // pnl = 0 because no other trader
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "0")
            })

            it("open short, price down, then short again", async () => {
                // alice opens short position with 100 margin, 2x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(100), toDecimal(2), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens short position with 150 margin, 2x leverage, price down
                // (800 - 300) * (125 + baseAssetDelta) = 100k, baseAssetDelta = 75
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(150), toDecimal(2), toDecimal(75), {
                    from: bob,
                })

                // alice's 25 short position worth 71.43 now
                // (500 + quoteAssetDelta) * (200 - 25) = 100k, quoteAssetDelta = -71.4285714286
                // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 71.4285714286 = 128.5714285714
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "128571428571428571428",
                )

                // alice opens short position with 100 margin, 3x leverage
                // (500 - 300) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 300
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(100),
                    toDecimal(3),
                    toDecimal(300),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // transferred margin = margin + fee = 100 + (100 * 3 * 10%) = 130
                assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), toFullDigit(-130, +(await quoteToken.decimals())).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = -25 - 300 = -325
                assert.equal((position.size).toString(), toFullDigit(-325).toString())
                // open notional = 200 + 300 = 500
                assert.equal((position.openNotional).toString(), toFullDigit(500).toString())
                // total position margin = 100 + 100 = 200
                assert.equal((position.margin).toString(), toFullDigit(200).toString())
            })

            it("open short, price up, then short again", async () => {
                // alice opens short position with 200 margin, 1x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(200), toDecimal(1), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens long position with 200 margin, 1x leverage, price up
                // (800 + 200) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -25
                await this.sakePerp.openPosition(this.exchange.address, BUY, toDecimal(200), toDecimal(1), toDecimal(25), {
                    from: bob,
                })

                // alice's 25 short position worth 333.33 now
                // (1000 + quoteAssetDelta) * (100 - 25) = 100k, quoteAssetDelta = 333.3333333333
                // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 333.3333333333 = -133.3333333333
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(),
                    "-133333333333333333334",
                )

                // alice opens short position with 50 margin, 4x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, SELL, toDecimal(50), toDecimal(4), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // then transferred margin = margin + fee = 50 + (50 * 4 * 10%) = 70
                assert.equal((aliceBalance2.sub(aliceBalance1)).toString(), (toFullDigit(-70, +(await quoteToken.decimals()))).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = -25 - 25 = -50
                assert.equal(position.size.toString(), toFullDigit(-50).toString())
                // open notional = 200 + 200 = 400
                assert.equal(position.openNotional.toString(), toFullDigit(400).toString())
                // total position margin = oldMargin + newMargin + realizedPnl = 200 + 50 + 0 = 250
                assert.equal(position.margin.toString(), toFullDigit(250).toString())
            })
        })
        
        
        //pass
        describe("reduce position", () => {
            it("open long position, price remains, then reduce position", async () => {
                // alice opens long position with 60 margin, 10x leverage
                // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                    from: alice,
                })

                // alice reduce position in 350 quoteAsset amount
                // (1600 - 350) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 17.5
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(350),
                    toDecimal(1),
                    toDecimal(17.5),
                    {
                        from: alice,
                    },
                )

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 37.5 - 17.5 = 20
                assert.equal((position.size).toString(), toFullDigit(20).toString())
                // openNotional = originalPositionNotional - reducedPositionNotional = 600 - 350 = 250
                assert.equal(position.openNotional.toString(), toFullDigit(250).toString())
                // total position margin = margin + realizedPnl = 60
                assert.equal(position.margin.toString(), toFullDigit(60).toString())
                // pnl is 0 because no other traders
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 0)
            })

            it("open long position, price remains, then reduce position - 0% fee", async () => {
                // given the fee is set to zero
                //await exchange.setTollRatio(toDecimal(0))
                await this.exchangeState.setSpreadRatio(toDecimal(0))

                // alice opens long position with 60 margin, 10x leverage
                // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                    from: alice,
                })

                // alice reduce position in 350 quoteAsset amount
                // (1600 - 350) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 17.5
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(350),
                    toDecimal(1),
                    toDecimal(17.5),
                    {
                        from: alice,
                    },
                )
                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 37.5 - 17.5 = 20
                assert.equal(position.size.toString(), toFullDigit(20).toString())
                // openNotional = positionNotional - unrealizedPnl = 250 - 0 = 250
                assert.equal(position.openNotional.toString(), toFullDigit(250).toString())
                // total position margin = 60 - 0 = 60
                assert.equal(position.margin.toString(), toFullDigit(60).toString())
                // pnl is 0 because no other traders
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "0")
            })

        //     //NEED DO!!
            // it("open short position, price remains, then reduce position", async () => {
            //     // alice opens short position with 60 margin, 10x leverage
            //     // (1000 - 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 150
            //     await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(60), toDecimal(10), toDecimal(150), {
            //         from: alice,
            //     })

            //     // alice reduce position in 400 quoteAsset amount
            //     // (400 + 400) * (250 + baseAssetDelta) = 100k, baseAssetDelta = -125
            //     await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(400), toDecimal(1), toDecimal(125), {
            //         from: alice,
            //     })

            //     const position = await this.sakePerp.getPosition(this.exchange.address, alice)
            //     // total position size = -150 + 125 = -25
            //     assert.equal(position.size.toString(), toFullDigit(-25).toString())
            //     // openNotional = positionNotional(200) - unrealizedPnl(0) = 200
            //     assert.equal(position.openNotional.toString(), toFullDigit(200).toString())
            //     // total position margin = margin + realizedPnl = 60 + 0 = 60
            //     assert.equal(position.margin.toString(), toFullDigit(60).toString())
            //     // pnl is 0 because no other traders
            //     assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "0")
            // })

            it("open long position, price up, then reduce position", async () => {
                // alice opens long position with 60 margin, 10x leverage
                // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                    from: alice,
                })

                // bob opens long position with 400 margin, 1x leverage. price up.
                // (1600 + 400) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(400), toDecimal(1), toDecimal(12.5), {
                    from: bob,
                })

                // alice's 37.5 long position worth 857.14 now
                // (2000 + quoteAssetDelta) * (50 + 37.5) = 100k, quoteAssetDelta = -857.1428571429
                // unrealizedPnl = positionNotional - openNotional = 857.1428571429 - 600 = 257.1428571429
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "257142857142857142857",
                )

                // alice reduce position in 400 quoteAsset amount
                // (2000 - 400) * (50 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(400),
                    toDecimal(1),
                    toDecimal(12.5),
                    {
                        from: alice,
                    },
                )

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 37.5 - 12.5 = 25
                assert.equal(position.size.toString(), toFullDigit(25).toString())
                // remain unrealizedPnl = unrealizedPnl - realizedPnl = 257.1428571429 - 85.7142857143 = 171.4285714286
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "171428571428571428572",
                )
                // alice's 25 long position worth 457.14 now
                // (1600 + quoteAssetDelta) * (62.5 + 25) = 100k, quoteAssetDelta = -457.1428571429
                // openNotional = positionNotional - unrealizedPnl = 457.1428571429 - 171.4285714286 = 285.7142857143
                assert.equal(position.openNotional.toString(), "285714285714285714285")
                // total position margin = 60 + realizedPnl = 60 + 85.61 = 145.61
                assert.equal(position.margin.toString(), "145714285714285714285")
            })

            it("open long position, price down, then reduce position", async () => {
                // alice opens long position with 500 margin, 2x leverage
                // (1000 + 1000) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -50
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(500), toDecimal(2), toDecimal(50), {
                    from: alice,
                })

                // bob opens short position with 400 margin, 1x leverage. price down
                // (2000 - 400) * (50 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(400),
                    toDecimal(1),
                    toDecimal(12.5),
                    {
                        from: bob,
                    },
                )

                // alice's 50 long position worth 711.11 now
                // (1600 + quoteAssetDelta) * (62.5 + 50) = 100k, quoteAssetDelta = -711.1111111111
                // unrealizedPnl = positionNotional - openNotional = 711.1111111111 - 1000 = -288.8888888888
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-288888888888888888889",
                )

                // alice reduce position in 350 quoteAsset amount
                // (1600 - 350) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 17.5
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(350),
                    toDecimal(1),
                    toDecimal(17.5),
                    {
                        from: alice,
                    },
                )

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 50 - 17.5 = 32.5
                assert.equal(position.size.toString(), toFullDigit(32.5).toString())
                // remain unrealizedPnl = unrealizedPnl - realizedPnl = -288.8888888888 + 101.1111111111 = -187.7777777777
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-187777777777777777778",
                )
                // alice's 32.5 long position worth 361.11 now
                // (1250 + quoteAssetDelta) * (80 + 32.5) = 100k, quoteAssetDelta = -361.1111111111
                // remainOpenNotional = remainPositionNotional - remainUnrealizedPnl = 361.1111111111 - (-187.7777777777) = 548.8888888888
                assert.equal(position.openNotional.toString(), "548888888888888888889")
                // total position margin = oldMargin + realizedPnl = 500 - 101.1111111111 = 398.888888889
                assert.equal(position.margin.toString(), "398888888888888888889")
            })

            it("open short position, price up, then reduce position", async () => {
                // alice opens short position with 100 margin, 2x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(25), {
                    from: alice,
                })

                // bob opens long position with 50 margin, 1x leverage. price up
                // (800 + 50) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -7.3529411765
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(50), toDecimal(1), toDecimal(7.35), {
                    from: bob,
                })

                // alice's 25 short position worth 229.37 now
                // (850 + quoteAssetDelta) * (117.6470588235 - 25) = 100k, quoteAssetDelta = 229.3650793654
                // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 229.3650793654 = -29.3650793654
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-29365079365079365079",
                )

                // alice reduce position in 150 quoteAsset amount
                // (850 + 150) * (117.6470588235 + baseAssetDelta) = 100k, baseAssetDelta = -17.6470588235
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.BUY,
                    toDecimal(150),
                    toDecimal(1),
                    toDecimal(17.64),
                    {
                        from: alice,
                    },
                )

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)

                // total position size = -25 + 17.6470588235 = -7.3529411765
                assert.equal(position.size.toString(), "-7352941176470588236")
                // remain unrealizedPnl = unrealizedPnl - realizedPnl = -29.3650793654 + 20.7282913155 = -8.6367880499
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-8636788048552754444",
                )
                // alice's 7.3529411765 short position worth 79.37 now
                // (1000 + quoteAssetDelta) * (100 + 7.3529411765) = 100k, quoteAssetDelta = -79.37
                // openNotional = positionNotional + unrealizedPnl = 79.37 + (-8.6367880499) = 70.7332119501
                assert.equal(position.openNotional.toString(), "70728291316526610643")
                // total position margin = margin + realizedPnl = 100 - 20.7282913155 = 79.2717086845
                assert.equal(position.margin.toString(), "79271708683473389357")
            })
        })
        
        
        
        describe("manually close position", () => {
            it("open long position, price remains, then close entire position manually", async () => {
                // alice opens long position with 50 margin, 5x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(50), toDecimal(5), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // alice opens short position with 250 margin, 1x leverage. (close position manually)
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(250),
                    toDecimal(1),
                    toDecimal(20),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = 100%
                // realizedPnl = unrealizedPnl * closeRatio = 0 * 100% = 0
                // closeMargin = currentMargin * closeRatio = 50 * 100% = 50
                // fee = 250 * 1 * 10% = 25
                // transferred margin = closedMargin + realizedPnl = 50 + 0 = 50
                await expectEvent.inTransaction(receipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: alice,
                    value: toFullDigit(50, +(await quoteToken.decimals())),
                })

                // transferred margin = closedMargin - fee + realizedPnl = 50 - 25 + 0 = 25
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), (toFullDigit(25, +(await quoteToken.decimals()))).toString())

                let position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal(position.size.toString(), toFullDigit(0).toString())
                assert.equal(position.openNotional.toString(), toFullDigit(0).toString())
                assert.equal(position.margin.toString(), toFullDigit(0).toString())
            })

            it("open short position, price remains, then closing entire position manually", async () => {
                // alice opens short position with 100 margin, 2x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(100), toDecimal(2), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // alice opens long position with 200 margin, 1x leverage. (close position manually)
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.BUY,
                    toDecimal(200),
                    toDecimal(1),
                    toDecimal(25),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = 100%
                // realizedPnl = unrealizedPnl * closeRatio = 0 * 100% = 0
                // closeMargin = currentMargin * closeRatio = 100 * 100% = 100
                // transferred margin = closedMargin + realizedPnl = 100 + 0 = 100
                await expectEvent.inTransaction(receipt.tx, quoteToken, "Transfer", {
                    from: this.sakePerpVault.address,
                    to: alice,
                    value: toFullDigit(100, +(await quoteToken.decimals())),
                })

                // fee = 200 * 1 * 10% = 20
                // TODO expect fee event
                // 100 - 20 = 80
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), (toFullDigit(80, +(await quoteToken.decimals()))).toString())

                let position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal(position.size.toString(), toFullDigit(0).toString())
                assert.equal(position.openNotional.toString(), toFullDigit(0).toString())
                assert.equal(position.margin.toString(), toFullDigit(0).toString())
            })

            it("open long position, price up, then close entire position manually", async () => {
                // given some other traders open some amount of position
                // to prevent vault doesnt have enough collateral to pay profit in this test case
                await transfer(admin, this.sakePerp.address, 1000)

                // alice opens long position with 25 margin, 10x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens long position with 35 margin, 10x leverage, price up
                // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(35), toDecimal(10), toDecimal(17.5), {
                    from: bob,
                })

                // alice's 20 long position worth 387.88 now
                // (1600 + quoteAssetDelta) * (62.5 + 20) = 100k, quoteAssetDelta = -387.8787878787
                // unrealizedPnl = positionNotional - cost = 387.8787878787 - 250 = 137.8787878787
                const currentPositionValue = await this.sakePerp.getPositionNotionalAndUnrealizedPnl(
                    this.exchange.address,
                    alice,
                    PnlCalcOption.SPOT_PRICE,
                )

                assert.equal(currentPositionValue[1].toString(), "137878787878787878787")

                // alice opens short position with 387.88 margin, 1x leverage. (close position manually)
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    { d: currentPositionValue[0].toString() },
                    toDecimal(1),
                    toDecimal(20),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = 100%
                // realizedPnl = unrealizedPnl * closeRatio = 137.8787878787 * 100% = 137.8787878787
                // closeMargin = currentMargin * closeRatio = 25 * 100% = 50
                // transferred margin = closedMargin + realizedPnl = 25 + 137.8787878787 = 162.8787878787
                // fee = 387.8787878787 * 10% = 38.7878787878
                // 162.8787878787 - 38.7878 = 124.0909878787
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), "124090909090909090909")

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal(position.size.toString(), toFullDigit(0).toString())
                assert.equal(position.openNotional.toString(), toFullDigit(0).toString())
                assert.equal(position.margin.toString(), toFullDigit(0).toString())
            })

            it("open long position, price down, then close entire position manually", async () => {
                // alice opens long position with 500 margin, 2x leverage
                // (1000 + 1000) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -50
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(500), toDecimal(2), toDecimal(50), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens short position with 400 margin, 1x leverage. price down
                // (2000 - 400) * (50 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(400),
                    toDecimal(1),
                    toDecimal(12.5),
                    {
                        from: bob,
                    },
                )

                // alice's 50 long position worth 711.11 now
                // (1600 + quoteAssetDelta) * (62.5 + 50) = 100k, quoteAssetDelta = -711.111111111111111111
                // unrealizedPnl = positionNotional - openNotional = 711.111111111111111111 - 1000 = -288.888888888888888888
                const currentPositionValue = await this.sakePerp.getPositionNotionalAndUnrealizedPnl(
                    this.exchange.address,
                    alice,
                    PnlCalcOption.SPOT_PRICE,
                )
                assert.equal(currentPositionValue[1].toString(), "-288888888888888888889")

                // alice opens short position with 711.11 margin, 1x leverage. (close position manually)
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    { d: currentPositionValue[0].toString() },
                    toDecimal(1),
                    toDecimal(50),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = 100%
                // realizedPnl = unrealizedPnl * closeRatio = -288.888888888888888888 * 100% = -288.888888888888888888
                // closeMargin = currentMargin * closeRatio = 500 * 100% = 500
                // fee = 711.111111111111111111 * 10% = 71.1111111111111111111
                // transferred margin = closedMargin - fee + realizedPnl = 500 - 71.1111111111111111111 - 288.888888888888888888 = 140
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), (toFullDigit(140, +(await quoteToken.decimals()))).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal(position.size.toString(), toFullDigit(0).toString())
                assert.equal(position.openNotional.toString(), toFullDigit(0).toString())
                assert.equal(position.margin.toString(), toFullDigit(0).toString())
            })

            it("open short position, price up, then close entire position manually", async () => {
                // alice opens short position with 200 margin, 1x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(200), toDecimal(1), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens long position with 50 margin, 1x leverage. price up
                // (800 + 50) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -7.3529411765
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(50), toDecimal(1), toDecimal(7.35), {
                    from: bob,
                })

                // alice's 25 short position worth 229.37 now
                // (850 + quoteAssetDelta) * (117.6470588235 - 25) = 100k, quoteAssetDelta = 229.3650793654
                // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 229.3650793654 = -29.3650793654
                const currentPositionValue = await this.sakePerp.getPositionNotionalAndUnrealizedPnl(
                    this.exchange.address,
                    alice,
                    PnlCalcOption.SPOT_PRICE,
                )
                assert.equal(currentPositionValue[1].toString(), "-29365079365079365079")

                // alice opens long position with 29.3650793654 margin, 1x leverage. (close position manually)
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.BUY,
                    { d: currentPositionValue[0].toString() },
                    toDecimal(1),
                    toDecimal(25),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = 100%
                // realizedPnl = unrealizedPnl * closeRatio = -29.3650793654 * 100% = -29.3650793654
                // closeMargin = currentMargin * closeRatio = 200 * 100% = 200
                // fee = 229.3650793654 * 1 * 10% = 22.9365079365
                // marginToTrader = closedMargin - fee + realizedPnl = 200 - 22.9365079365 - 29.3650793654 = 147.6984126981
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), "147698412698412698414")

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                assert.equal(position.size.toString(), toFullDigit(0).toString())
                assert.equal(position.openNotional.toString(), toFullDigit(0).toString())
                assert.equal(position.margin.toString(), toFullDigit(0).toString())
            })

            //NEED DO!!
            // it("open short position, price down, then close entire position manually", async () => {
            //     // given some other traders open some amount of position
            //     // to prevent vault doesn't have enough collateral to pay profit in this test case
            //     await transfer(admin, this.sakePerp.address, 1000)

            //     // alice opens short position with 250 margin, 2x leverage
            //     // (1000 - 500) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 100
            //     await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(250), toDecimal(2), toDecimal(100), {
            //         from: alice,
            //     })
            //     const aliceBalance1 = await quoteToken.balanceOf(alice)

            //     // bob opens short position with 100 margin, 1x leverage. price down
            //     // (500 - 100) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 50
            //     await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(100), toDecimal(1), toDecimal(50), {
            //         from: bob,
            //     })

            //     // alice's 100 short position worth 266.67 now
            //     // (400 + quoteAssetDelta) * (250 - 100) = 100k, quoteAssetDelta = 266.666666666666666666
            //     // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 500 - 266.666666666666666666 = 233.333333333333333333
            //     const currentPositionValue = await this.sakePerp.getPositionNotionalAndUnrealizedPnl(
            //         this.exchange.address,
            //         alice,
            //         PnlCalcOption.SPOT_PRICE,
            //     )
            //     assert.equal(currentPositionValue[1].toString(), "233333333333333333333")

            //     // alice opens long position with 266.666666666666666666 margin, 1x leverage. (close position manually)
            //     const receipt = await this.sakePerp.openPosition(
            //         this.exchange.address,
            //         Side.BUY,
            //         { d: currentPositionValue[0].toString() },
            //         toDecimal(1),
            //         toDecimal(100),
            //         {
            //             from: alice,
            //         },
            //     )
            //     const aliceBalance2 = await quoteToken.balanceOf(alice)

            //     // closeRatio = closePositionSize/positionSize = 100%
            //     // realizedPnl = unrealizedPnl * closeRatio = 233.333333333333333333 * 100% = 233.333333333333333333
            //     // closeMargin = currentMargin * closeRatio = 250 * 100% = 250
            //     // newRequireMargin = abs(newPositionNotional / newLeverage) = 0
            //     // fee = 266.666666666666666666 * 1 * 10% = 26.666666666666666666
            //     // marginToTrader = closedMargin - newRequireMargin - fee + realizedPnl = 250 - 0 - 26.66 + 233.33 = 456.67
            //     assert.equal(aliceBalance2.sub(aliceBalance1).toString(), "456666666666666666667")

            //     const position = await this.sakePerp.getPosition(this.exchange.address, alice)
            //     assert.equal(position.size.toString(), toFullDigit(0).toString())
            //     assert.equal(position.openNotional.toString(), toFullDigit(0).toString())
            //     assert.equal(position.margin.toString(), toFullDigit(0).toString())
            // })
        })

        
        
        describe("opens a position, then opens an larger position in reversed direction", () => {
            it("open long position, price remains, then close entire position by opening another larger short", async () => {
                // alice opens long position with 125 margin, 2x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(125), toDecimal(2), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // alice opens short position with 45 margin, 10x leverage, price down
                // (1250 - 450) * (80 + baseAssetDelta) = 100k, baseAssetDelta = 45
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(45),
                    toDecimal(10),
                    toDecimal(45),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = max(1, 45/20) = 100%
                // realizedPnl = unrealizedPnl * closeRatio = 0
                // closeMargin = currentMargin * closeRatio = 125
                // fee = 45 * 10 * 10% = 45
                // remainPositionNotional = 450 - 250 = 200
                // newRequireMargin = abs(newPositionNotional / newLeverage) = abs(200/10) = 20
                // marginToVault = newRequireMargin - closedMargin + fee - realizedPnl = 20 - 125 + 45 - 0 = -60
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), (toFullDigit(60, +(await quoteToken.decimals()))).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 20 - 45 = -25
                assert.equal(position.size.toString(), toFullDigit(-25).toString())
                // alice's 25 short position worth 200 now
                // (800 + quoteAssetDelta) * (125 - 25) = 100k, quoteAssetDelta = 200
                // openNotional = positionNotional - unrealizedPnl = 200 - 0 = 200
                assert.equal(position.openNotional.toString(), toFullDigit(200).toString())
                // newRequireMargin
                assert.equal(position.margin.toString(), toFullDigit(20).toString())
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "0")
            })

            it("open short position, price remains, then close entire position by opening another larger long", async () => {
                // alice opens short position with 20 margin, 10x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(20), toDecimal(10), toDecimal(25), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // alice opens long position with 90 margin, 5 leverage, price up
                // (800 + 450) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -45
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.BUY,
                    toDecimal(90),
                    toDecimal(5),
                    toDecimal(45),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = max(1, 45/25) = 100%
                // realizedPnl = unrealizedPnl * closeRatio = 0
                // closeMargin = currentMargin * closeRatio = 20
                // remainPositionNotional = 450 - 200 = 250
                // newRequireMargin = remainPositionNotional / newLeverage = 250/5 = 50
                // fee = 90 * 5 * 10% = 45
                // marginToTrader = closedMargin - newRequireMargin - fee + realizedPnl = 20 - 50 - 45 + 0 = -75
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), toFullDigit(-75, +(await quoteToken.decimals())).toString())

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = -25 + 45 = 20
                assert.equal(position.size.toString(), toFullDigit(20).toString())
                // alice's 20 long position worth 250 now
                // (1250 + quoteAssetDelta) * (80 + 20) = 100k, quoteAssetDelta = -250
                // openNotional = positionNotional - unrealizedPnl = 250 - 0 = 250
                assert.equal(position.openNotional.toString(), toFullDigit(250).toString())
                // total position margin = 90 - 50 = 40
                assert.equal(position.margin.toString(), toFullDigit(50).toString())
                // pnl is 0 because alice closed her entire position and opens new position in reverse dir
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "0")
            })

        //     //NEED DO!!
            it("open long position, price up, then close entire position by opening another larger short", async () => {
                // alice opens long position with 25 margin, 10x leverage
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens long position with 35 margin, 10x leverage, price up
                // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(35), toDecimal(10), toDecimal(17.5), {
                    from: bob,
                })

                // alice's 20 long position worth 387.88 now
                // (1600 + quoteAssetDelta) * (62.5 + 20) = 100k, quoteAssetDelta = -387.878787878787878787
                // unrealizedPnl = positionNotional - cost = 387.878787878787878787 - 250 = 137.878787878787878787
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "137878787878787878787",
                )

                // alice opens short position with 100 margin, 8x leverage
                // (1600 - 800) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 62.5
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(100),
                    toDecimal(8),
                    toDecimal(62.51),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = max(1, 62.5/20) = 100%
                // realizedPnl = unrealizedPnl * closeRatio = 137.878787878787878787
                // closeMargin = currentMargin * closeRatio = 100
                // remainPositionNotional = 800 - 387.88 = 412.12
                // requiredNewMargin = remainPositionNotional/newLeverage = 412.12/8 = 51.515
                // fee = 100 * 8 * 10% = 80
                // marginToVault = closeMarginToVault + requiredNewMargin = = -(25 + 137.87) + 51.515 = -111.355
                // marginToTrader = - marginToVault - fee = 111.355 - 80 = 31.355
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), "31363636363636363636")

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 20 - 62.5 = -42.5
                assert.equal(position.size.toString(), "-42500000000000000001")
                // remain unrealizedPnl = unrealizedPnl - realizedPnl ~= 0
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "-9")
                // alice's 42.5 short position worth 412.12 now
                // (800 + quoteAssetDelta) * (125 - 42.5) = 100k, quoteAssetDelta = 412.121212121212121212
                // openNotional = positionNotional + unrealizedPnl = 412.121212121212121212
                assert.equal(position.openNotional.toString(), "412121212121212121213")
                // requiredNewMargin = remainPositionNotional/newLeverage = 412.12/8 = 51.515
                assert.equal(position.margin.toString(), "51515151515151515151")
            })

            //NEED DO!!
            it("open long position, price down, then close entire position by opening another larger short", async () => {
                // alice opens long position with 125 margin, 2x leverage
                // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(125), toDecimal(2), toDecimal(20), {
                    from: alice,
                })
                const aliceBalance1 = await quoteToken.balanceOf(alice)

                // bob opens short position with 125 margin, 2x leverage, price down
                // (1250 - 250) * (80 + baseAssetDelta) = 100k, baseAssetDelta = 20
                await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(125), toDecimal(2), toDecimal(20), {
                    from: bob,
                })

                // alice's 20 long position worth 166.67 now
                // (1000 + quoteAssetDelta) * (100 + 20) = 100k, quoteAssetDelta = -166.666666666666666666
                // unrealizedPnl = positionValue - cost = 166.666666666666666666 - 250 = -83.333333333333333333
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-83333333333333333334",
                )

                // alice opens short position with 60 margin, 10x leverage
                // (1000 - 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 150
                const receipt = await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.SELL,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(1450),
                    {
                        from: alice,
                    },
                )
                const aliceBalance2 = await quoteToken.balanceOf(alice)

                // closeRatio = closePositionSize/positionSize = max(1, 150/20) = 100%
                // realizedPnl = unrealizedPnl * closeRatio = -83.333333333333333333
                // closeMargin = currentMargin * closeRatio = 125
                // remainPositionNotional = 600 - 166.67 = 433.33
                // requiredNewMargin = remainPositionNotional / leverage = 433.33 / 10
                // fee = 60 * 10 * 10% = 60
                // marginToTrader = closedMargin - requiredNewMargin - fee + realizedPnl = 125 - 43.33 - 60 + (-83.33) = -61.66
                assert.equal(aliceBalance2.sub(aliceBalance1).toString(), "-61666666666666666667")

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 20 - 150 = -130
                assert.equal(position.size.toString(), "-130000000000000000001")
                // remain unrealizedPnl = unrealizedPnl - realizedPnl = 0
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), "-3")
                // alice's 130 short position worth 433.33 now
                // (400 + quoteAssetDelta) * (250 - 130) = 100k, quoteAssetDelta = 433.333333333333333333
                // openNotional = positionNotional + unrealizedPnl = 433.333333333333333333 0
                assert.equal(position.openNotional.toString(), "433333333333333333334")
                // total position margin = 433.33 / 10
                assert.equal(position.margin.toString(), "43333333333333333333")
            })

            it("open short position, price up, then close entire position by opening another larger long", async () => {
                // alice opens short position with 200 margin, 1x leverage
                // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
                await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(200), toDecimal(1), toDecimal(25), {
                    from: alice,
                })

                // bob opens long position with 50 margin, 4x leverage. price up
                // (800 + 200) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -25
                // return size might loss 1 wei
                await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal(50), toDecimal(4), toDecimal(7.349), {
                    from: bob,
                })

                // alice's 25 short position worth 333.333333333333333333 now
                // (1000 + quoteAssetDelta) * (100 - 25) = 100k, quoteAssetDelta = 333.333333333333333333
                // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 333.333333333333333333 = -133.333333333333333333
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-133333333333333333334",
                )

                // alice opens long position with 60 margin, 10x leverage
                // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
                // return size might loss 1 wei
                await this.sakePerp.openPosition(
                    this.exchange.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(37.49),
                    {
                        from: alice,
                    },
                )

                const position = await this.sakePerp.getPosition(this.exchange.address, alice)
                // total position size = 37.5 - 25 = 12.5 - 1 wei
                assert.equal(position.size.toString(), "12499999999999999999")
                // remain unrealizedPnl = 0 because alice already close old position and opens new position in reverse side
                // should be 0 but got -21 due to rounding error
                assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                    "-21",
                )

                // alice's 12.5 long position worth 433.33 now
                // (1600 + quoteAssetDelta) * (62.5 + 12.5) = 100k, quoteAssetDelta = -266.666666666666666666
                // openNotional = positionNotional - unrealizedPnl = 266.666666666666666666 - 0
                assert.equal(position.openNotional.toString(), "266666666666666666666")
                // margin is positionNotional / leverage = 26.66
                assert.equal(position.margin.toString(), "26666666666666666666")
            })

        //     //NEED DO!!
            // it("open short position, price down, then close entire position by opening another larger long", async () => {
            //     // given some other traders open some amount of position
            //     // to prevent vault doesn't have enough collateral to pay profit in this test case
            //     await transfer(admin, this.sakePerp.address, 1000)

            //     // alice opens short position with 500 margin, 1x leverage
            //     // (1000 - 500) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 100
            //     await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(500), toDecimal(1), toDecimal(100), {
            //         from: alice,
            //     })
            //     const aliceBalance1 = await quoteToken.balanceOf(alice)

            //     // bob opens short position with 100 margin, 1x leverage. price down
            //     // (500 - 100) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 50
            //     // return size might loss 1 wei
            //     await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal(100), toDecimal(1), toDecimal(50), {
            //         from: bob,
            //     })

            //     // alice's 100 short position worth 266.666666666666666666 now
            //     // (400 + quoteAssetDelta) * (250 - 100) = 100k, quoteAssetDelta = 266.666666666666666666
            //     // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 500 - 266.666666666666666666 = 233.333333333333333333
            //     assert.equal((await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
            //         "233333333333333333333",
            //     )

            //     // alice opens long position with 60 margin, 10x leverage
            //     // (400 + 600) * (250 + baseAssetDelta) = 100k, baseAssetDelta = -150
            //     // return size might loss 1 wei
            //     const receipt = await this.sakePerp.openPosition(
            //         this.exchange.address,
            //         Side.BUY,
            //         toDecimal(60),
            //         toDecimal(10),
            //         toDecimal(149.99),
            //         {
            //             from: alice,
            //         },
            //     )
            //     const aliceBalance2 = await quoteToken.balanceOf(alice)

            //     // closeRatio = closePositionSize/positionSize = 100%
            //     // realizedPnl = unrealizedPnl * closeRatio = 233.333333333333333333
            //     // closeMargin = currentMargin * closeRatio = 500
            //     // remainPositionNotional = 600 - 266.66 = 333.33
            //     // newRequiredMargin = 333.33 / 10
            //     // fee = 60 * 10 * 10% = 60
            //     // then transferred margin = closedMargin - fee + realizedPnl - newRequiredMargin = 500 - 60 + 233.33 - 333.33 = 640
            //     assert.equal(aliceBalance2.sub(aliceBalance1).toString(), (toFullDigit(640, +(await quoteToken.decimals()))).toString())

            //     const position = await this.sakePerp.getPosition(this.exchange.address, alice)
            //     // total position size = 150 - 100 = 50 - 1 wei
            //     assert.equal(position.size.toString(), "49999999999999999999")
            //     // const pnl = await this.sakePerpviewer.getUnrealizedPnl(this.exchange.address, alice, PnlCalcOption.SPOT_PRICE)
            //     // TODO should be 0 but got 2 wei, rounding error?
            //     // expect(pnl).eq(0)

            //     // alice's 50 long position worth 333.33 now
            //     // (1000 + quoteAssetDelta) * (100 + 50) = 100k, quoteAssetDelta = -333.33
            //     // openNotional = positionNotional - unrealizedPnl = 333.33 - 0 = 333.33
            //     assert.equal(position.openNotional.toString(), "333333333333333333333")
            //     // total position margin = 333.33 / 10
            //     assert.equal(position.margin.toString(), "33333333333333333333")
            // })
        })
    })
})

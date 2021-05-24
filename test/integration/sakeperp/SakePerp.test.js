const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const IExchange = artifacts.require('IExchange');
const Exchange = artifacts.require('Exchange');
const ExchangeFake = artifacts.require('ExchangeFake');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const L2PriceFeedFake = artifacts.require('L2PriceFeedFake');
const ERC20Token = artifacts.require('ERC20Token');
const InsuranceFund = artifacts.require('InsuranceFund');
const SakePerp = artifacts.require('SakePerp');
const SakePerpState = artifacts.require('SakePerpState');
const SakePerpFake = artifacts.require('SakePerpFake');
const SakePerpViewer = artifacts.require('SakePerpViewer');
const SakePerpVault = artifacts.require('SakePerpVault');
const SystemSettingsFake = artifacts.require('SystemSettingsFake');
const TraderWallet = artifacts.require("TraderWallet");
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('../../helper/number');
const truffleAssert = require("truffle-assertions");
const { accessSync } = require('fs');

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
    fundingPeriod: new BN(86400), // 8hr
    fluctuation: toFullDigit(0),
    priceAdjustRatio: floatToDecimal(0.1), 
}

contract("SakePerp Test", ([admin, alice, bob, carol, relayer]) => {

    let insuranceFund = null;
    let quoteToken = null;
    let sakePerpViewer = null;
    let exchange = null;
    let mockPriceFeed = null;
    let sakePerp = null;
    let sakePerpstate = null;
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

    let overnightFeeLpShare = 0.5
    let fundingFeeLpShare = 0.5

    async function forwardBlockTimestamp(time){
        const now = await exchange.mock_getCurrentTimestamp()
        const newTime = now.addn(time)
        await exchange.mock_setBlockTimestamp(newTime)

        //await clearingHouse.mock_setBlockTimestamp(newTime)
        const movedBlocks = time / 15 < 1 ? 1 : time / 15

        const blockNumber = await exchange.mock_getCurrentBlockNumber()
        const newBlockNumber = blockNumber.addn(movedBlocks)

        await exchange.mock_setBlockNumber(newBlockNumber)
        //await clearingHouse.mock_setBlockNumber(newBlockNumber)
    }

    // copy from above so skip the comment for calculation
    async function makeLiquidatableByShort(addr) {
        await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(0), {
            from: admin,
        })
        await forwardBlockTimestamp(15)
        await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(0), {
            from: addr,
        })
        await forwardBlockTimestamp(15)
        await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
            from: admin,
        })
        await forwardBlockTimestamp(15)
    }

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
        this.exchangeState = await ExchangeState.new()
        
        quoteToken = this.quoteAsset;
        
        this.systemSettings = await SystemSettingsFake.new();
        this.sakePerp = await SakePerpFake.new();
        this.sakePerpviewer = await SakePerpViewer.new();
        this.sakePerpVault = await SakePerpVault.new();
        this.SakePerpState = await SakePerpState.new();
        await this.SakePerpState.initialize(this.sakePerp.address, "0");

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
        await this.systemSettings.setOvernightFeeRatio(floatToDecimal(0.003));
        await this.systemSettings.setOvernightFeePeriod(86400);

        await this.systemSettings.setOvernightFeeLpShareRatio(floatToDecimal(overnightFeeLpShare));
        await this.systemSettings.setFundingFeeLpShareRatio(floatToDecimal(fundingFeeLpShare));

        await this.sakePerpVault.initialize(this.sakePerp.address, this.systemSettings.address);
        await this.sakePerp.initialize(this.systemSettings.address, this.sakePerpVault.address, this.SakePerpState.address);
        await this.sakePerpviewer.initialize(this.sakePerp.address, this.systemSettings.address);
        this.exchange = await ExchangeFake.new(
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
        await this.exchange.fakeInitialize()
        await this.insuraceFund.initialize(this.exchange.address, this.sakePerpVault.address);

        this.exchangeState.initialize(
            this.exchange.address,
            toFullDigitStr("0"),
            toFullDigitStr("0.05"),
            toFullDigitStr("0.05"),
            toFullDigitStr("0.05"),
            toFullDigitStr("100"),
            toFullDigitStr("0.1"),
        )
        
        await this.exchange.setMover(admin)
        await this.exchange.setExchangeState(this.exchangeState.address)
        await this.exchange.setOpen(true);
        await this.exchange.setCounterParty(this.sakePerp.address);
        await this.exchange.setMinter(this.sakePerpVault.address);
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);

        insuranceFund = this.insuraceFund;
        exchange = this.exchange;
        sakePerpViewer = this.sakePerpviewer;
        sakePerp = this.sakePerp;
        mockPriceFeed = this.priceFeed;
        sakePerpstate = this.SakePerpState;

        // Each of Alice & Bob have 5000 DAI
        await quoteToken.transfer(alice, toFullDigit(5000, +(await quoteToken.decimals())))
        await quoteToken.transfer(bob, toFullDigit(5000, +(await quoteToken.decimals())))
        await quoteToken.transfer(insuranceFund.address, toFullDigit(5000))

        await this.exchangeState.setCap(toDecimal(0), toDecimal(0))
    })


    async function gotoNextFundingTime() {
        const nextFundingTime = await exchange.nextFundingTime()
        await exchange.mock_setBlockTimestamp(nextFundingTime)
    }

    async function approve(account, spender, amount) {
        await quoteToken.approve(spender, toFullDigit(amount, +(await quoteToken.decimals())), { from: account })
    }

    async function transfer(from, to, amount) {
        await quoteToken.transfer(to, toFullDigit(amount, +(await quoteToken.decimals())), { from })
    }

    describe("getPersonalPositionWithFundingPayment", () => {
        it("return 0 margin when alice's position is underwater", async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            // given alice takes 10x short position (size: -150) with 60 margin
            await approve(alice, sakePerp.address, 60)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(60), toDecimal(10), toDecimal(150), {
                from: alice,
            })

            // given the underlying twap price is $2.1, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(floatToDecimal(2.1).d);

            console.log((await this.exchange.getUnderlyingTwapPrice(60 * 60)).toString());
            console.log((await this.exchange.getUnderlyingTwapPrice(60 * 60)).toString());
            console.log((await this.exchange.getTwapPrice(60 * 60)).toString());

            // when the new fundingRate is -50% which means underlyingPrice < snapshotPrice
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            //AssertionError: expected '-166666666666666666' to equal '-500000000000000000'
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), toFullDigit(-0.5).toString())

            // then alice need to pay 150 * 50% = $75
            // {size: -150, margin: 300} => {size: -150, margin: 0}
        })
    })


    describe("payOvernightFee", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await this.exchangeState.setCap(toDecimal(0), toDecimal(600))
            await approve(alice, sakePerp.address, 600)
            await approve(bob, sakePerp.address, 600)
        })

        it("payovernightFee Right", async () => {
            const priceFeedKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
            await approve(alice, sakePerp.address, 100)
            let aliceBeforeBalance = await quoteToken.balanceOf(alice)
            let receipt = await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(60), toDecimal(3), toDecimal(150), {
                from: alice,
            })

            let txFee = new BN(0)
            truffleAssert.eventEmitted(receipt, "PositionChanged", (ev) => {
                assert.equal(ev.fundingPayment.toString(), "0", "error funding payment");
                assert.equal(ev.overnightPayment.toString(), "0");
                txFee.add(ev.fee)
                return true;
            });
           

            let aliceFirstFundingRate = new BN((await sakePerp.getLatestCumulativePremiumFraction(this.exchange.address)).toString())
            let aliceFirstOvernightRate = new BN((await sakePerp.getLatestCumulativeOvernightFeeRate(this.exchange.address)).toString())
            assert.equal(aliceFirstFundingRate.toString(), "0")
            assert.equal(aliceFirstOvernightRate.toString(), "0")
            await expectRevert(this.sakePerp.payOvernightFee(this.exchange.address), "pay overnight fee too early");
            await this.systemSettings.mock_setBlockTimestamp(new BN(await this.systemSettings.mock_getCurrentTimestamp()).add(new BN(86400 + 1)));
            receipt = await this.sakePerp.payOvernightFee(this.exchange.address);
            await expectEvent.inTransaction(receipt.tx, sakePerp, "OvernightFeePayed", {
                totalOpenNotional : toFullDigitStr(60 * 3),
                overnightFee : toFullDigitStr(60 * 3 * 0.003),
                rate : toFullDigitStr(0.003),
            })  
            
            await this.systemSettings.mock_setBlockTimestamp(new BN(await this.systemSettings.mock_getCurrentTimestamp()).add(new BN(86400 + 1)));
            receipt = await this.sakePerp.payOvernightFee(this.exchange.address);
            await expectEvent.inTransaction(receipt.tx, sakePerp, "OvernightFeePayed", {
                totalOpenNotional : toFullDigitStr(60 * 3),
                overnightFee : toFullDigitStr(60 * 3 * 0.003),
                rate : toFullDigitStr(0.003),
            })  

            let spotPrice = new BN((await this.exchange.getSpotPrice()).toString())
            let oraclePrice = spotPrice.add(new BN(3999999999999999))
            console.log(spotPrice.toString())
            console.log(oraclePrice.toString())
            console.log((await this.exchange.nextFundingTime()).toString())
            receipt = await this.exchange.moveAMMPriceToOracle(oraclePrice, priceFeedKey)
            console.log((await this.exchange.lastMoveAmmPriceTime()).toString())
            await this.exchange.mock_setBlockTimestamp(new BN(await this.exchange.mock_getCurrentTimestamp()).add(new BN(3600 + 1)) )
            await this.exchange.setOpen(false)
            await this.exchange.setOpen(true)
            console.log("currentTime:", (await this.exchange.mock_getCurrentTimestamp()).toString())
            console.log("nextFundingTime:", (await this.exchange.nextFundingTime()).toString())
            await this.exchange.mock_setBlockTimestamp(new BN(await this.exchange.nextFundingTime()).add(new BN(3600 + 1)) )
            receipt = await this.sakePerp.payFunding(this.exchange.address);

            let currentFundingRate = new BN((await sakePerp.getLatestCumulativePremiumFraction(this.exchange.address)).toString())
            console.log(currentFundingRate.toString())

            let alicePosition = await sakePerp.getPosition(this.exchange.address, alice)
            console.log(alicePosition)

            let fundRate = currentFundingRate.sub(aliceFirstFundingRate)
            let currentOvernightFeeRate = new BN((await sakePerp.getLatestCumulativeOvernightFeeRate(this.exchange.address)).toString())
            let fundpayment = fundRate.mul(new BN(alicePosition.size.toString()))
            fundpayment = fundpayment.div(toFullDigit(1))
            let overnightRate = currentOvernightFeeRate.sub(aliceFirstOvernightRate)
            let overnightFee = overnightRate.mul(new BN(alicePosition.openNotional.toString()))
            overnightFee = overnightFee.div(toFullDigit(1))

            receipt = await this.sakePerp.closePosition(this.exchange.address, toDecimal(0), {from:alice})
            truffleAssert.eventEmitted(receipt, "PositionChanged", (ev) => {
                assert.equal(ev.fundingPayment.toString(), fundpayment.toString(), "error funding payment");
                assert.equal(ev.overnightPayment.toString(), overnightFee.toString(), "error overnight");
                txFee.add(ev.fee)
                return true;
            });
        })
    })

    describe("openInterestNotional", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await this.exchangeState.setCap(toDecimal(0), toDecimal(600))
            await approve(alice, sakePerp.address, 600)
            await approve(bob, sakePerp.address, 600)
        })

        it("increase when increase position", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(600), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            assert.equal((await sakePerpstate.openInterestNotionalMap(exchange.address)).toString(), toFullDigitStr(600).toString())
        })

        it("reduce when reduce position", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(600), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(300), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            assert.equal((await sakePerpstate.openInterestNotionalMap(exchange.address)).toString(), toFullDigitStr(300).toString())
        })

        it("reduce when close position", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(400), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })

            // expect the result will be almost 0 (with a few rounding error)
            const openInterestNotional = await sakePerpstate.openInterestNotionalMap(exchange.address)
            assert.equal(openInterestNotional.toNumber() < 10, true)
        })

        it("increase when traders open positions in different direction", async () => {
            await approve(alice, sakePerp.address, 300)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(300), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await approve(bob, sakePerp.address, 300)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(300), toDecimal(1), toDecimal(0), {
                from: bob,
            })
            assert.equal((await sakePerpstate.openInterestNotionalMap(exchange.address)).toString(), toFullDigitStr(600))
        })

        it("increase when traders open larger position in reverse direction", async () => {
            await approve(alice, sakePerp.address, 600)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(250), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(450), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            assert.equal((await sakePerpstate.openInterestNotionalMap(exchange.address)).toString(), toFullDigitStr(200))
        })

        it("is 0 when everyone close position", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(250), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(250), toDecimal(1), toDecimal(0), {
                from: bob,
            })
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })

            // expect the result will be almost 0 (with a few rounding error)
            const openInterestNotional = await sakePerpstate.openInterestNotionalMap(exchange.address)
            assert.equal(openInterestNotional.toNumber() < 10, true)
        })

        it("stop trading if it's over openInterestCap", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(600), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await expectRevert(
                sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(1), toDecimal(1), toDecimal(0), {
                    from: alice,
                }),
                "over limit",
            )
        })

        it("won't stop trading if it's reducing position, even it's more than cap", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(600), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await this.exchangeState.setCap(toDecimal(0), toDecimal(300))
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(300), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            assert.equal((await sakePerpstate.openInterestNotionalMap(exchange.address)).toString(), toFullDigitStr(300))
        })
    })
    

    describe("payFunding", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            // given alice takes 2x long position (37.5Q) with 300 margin
            await approve(alice, sakePerp.address, 600)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(300), toDecimal(2), toDecimal(37.5), {
                from: alice,
            })

            // given bob takes 1x short position (-187.5Q) with 1200 margin
            await approve(bob, sakePerp.address, 1200)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(1200), toDecimal(1), toDecimal(187.5), {
                from: bob,
            })

            const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(this.sakePerpVault.address)
            // 300 (alice's margin) + 1200 (bob' margin) = 1500
            assert.equal(clearingHouseBaseTokenBalance.toString(), (toFullDigit(11500, +(await quoteToken.decimals()))).toString())
        })

        it("will generate loss for exchange when funding rate is positive and exchange hold more long position", async () => {
            // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(1.59))

            // when the new fundingRate is 1% which means underlyingPrice < snapshotPrice
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), toFullDigit(0.01).toString())

            // then alice need to pay 1% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
            const alicePosition = await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)
            assert.equal(alicePosition.size.toString(), toFullDigit(37.5).toString())
            assert.equal(alicePosition.margin.toString(), toFullDigit(299.625).toString())

            // then bob will get 1% of her position size as fundingPayment
            // {balance: -187.5, margin: 1200} => {balance: -187.5, margin: 1201.875}
            const bobPosition = await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, bob)
            assert.equal(bobPosition.size.toString(), toFullDigit(-187.5).toString())
            assert.equal(bobPosition.margin.toString(), toFullDigit(1201.875).toString())

            // then fundingPayment will generate 1.5 loss and sakePerp will withdraw in advanced from insuranceFund
            // sakePerp: 1500 + 1.5
            // insuranceFund: 5000 - 1.5
            const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(this.sakePerpVault.address)
            assert.equal(clearingHouseQuoteTokenBalance.toString(), toFullDigit(11501.5, +(await quoteToken.decimals())).toString())
            const insuranceFundBaseToken = await quoteToken.balanceOf(insuranceFund.address)
            assert.equal(insuranceFundBaseToken.toString(), (toFullDigit(4998.5, +(await quoteToken.decimals()))).toString())
        })

        it("funding rate is 1%, 1% then -1%", async () => {
            // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(1.59))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(0.01)).toString())

            // then alice need to pay 1% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(299.625).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(299.625).toString(),
            )

            // pay 1% funding again
            // {balance: 37.5, margin: 299.625} => {balance: 37.5, margin: 299.25}
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), toFullDigit(0.02).toString())
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(299.25).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(299.25).toString(),
            )

            // pay -1% funding
            // {balance: 37.5, margin: 299.25} => {balance: 37.5, margin: 299.625}
            await mockPriceFeed.setTwapPrice(toFullDigit(1.61))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), toFullDigit(0.01).toString())
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(299.625).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(299.625).toString(),
            )
        })

        it("funding rate is 1%, -1% then -1%", async () => {
            // given the underlying twap price is 1.59, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(1.59))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)

            // then alice need to pay 1% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 299.625}
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), toFullDigit(0.01).toString())
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(299.625).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(),
                toFullDigit(299.625).toString(),
            )

            // pay -1% funding
            // {balance: 37.5, margin: 299.625} => {balance: 37.5, margin: 300}
            await gotoNextFundingTime()
            await mockPriceFeed.setTwapPrice(toFullDigit(1.61))
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), toFullDigit(0).toString())
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(300).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(300).toString(),
            )

            // pay -1% funding
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 300.375}
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(-0.01)).toString())
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(300.375).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(300.375).toString(),
            )
        })

        it("has huge funding payment profit that doesn't need margin anymore", async () => {
            // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(21.6))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)

            // then alice will get 2000% of her position size as fundingPayment
            // {balance: 37.5, margin: 300} => {balance: 37.5, margin: 1050}
            // then alice can withdraw more than her initial margin while remain the enough margin ratio
            await sakePerp.removeMargin(exchange.address, toDecimal(400), { from: alice })

            // margin = 1050 - 400 = 650
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).margin.toString(), 
                toFullDigit(650).toString(),
            )
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(), 
                toFullDigit(650).toString(),
            )
        })

        it("has huge funding payment loss that the margin become 0 with bad debt of long position", async () => {
            // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(21.6))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)

            // then bob will get 2000% of her position size as fundingPayment
            // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, bob)).margin.toString(), 
                toFullDigit(0).toString(),
            )

            const receipt = await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "PositionChanged", {
                badDebt: toFullDigitStr(2550),
                fundingPayment: toFullDigitStr(3750),
            })
        })

        it("has huge funding payment loss that the margin become 0, can add margin", async () => {
            // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(21.6))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)

            // then bob will get 2000% of her position size as fundingPayment
            // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
            // margin can be added but will still shows 0 until it's larger than bad debt
            await approve(bob, sakePerp.address, 1)
            await sakePerp.addMargin(exchange.address, toDecimal(1), { from: bob })
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, bob)).margin.toString(),
                toFullDigit(0).toString(),
            )
        })

        it("has huge funding payment loss that the margin become 0, can not remove margin", async () => {
            // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(21.6))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)

            // then bob will get 2000% of her position size as fundingPayment
            // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
            // margin can't removed
            await expectRevert(
                sakePerp.removeMargin(exchange.address, toDecimal(1), { from: bob }),
                "margin is not enough",
            )
        })

        it("reduce bad debt after adding margin to a underwater position", async () => {
            // given the underlying twap price is 21.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(21.6))
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)

            // then bob will get 2000% of her position size as fundingPayment
            // funding payment: -187.5 x 2000% = -3750, margin is 1200 so bad debt = -3750 + 1200 = 2550
            // margin can be added but will still shows 0 until it's larger than bad debt
            // margin can't removed
            await approve(bob, sakePerp.address, 10)
            await sakePerp.addMargin(exchange.address, toDecimal(10), { from: bob })

            // badDebt 2550 - 10 margin = 2540
            const receipt = await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "PositionChanged", {
                badDebt: toFullDigitStr(2540),
                fundingPayment: toFullDigitStr(3750),
            })
        })

        it("will change nothing if the funding rate is 0", async () => {
            // when the underlying twap price is $1.6, and current snapShot price is 400B/250Q = $1.6
            await mockPriceFeed.setTwapPrice(toFullDigit(1.6))

            // when the new fundingRate is 0% which means underlyingPrice = snapshotPrice
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), "0")

            // then alice's position won't change
            // {balance: 37.5, margin: 300}
            const alicePosition = await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)
            assert.equal(alicePosition.size.toString(), toFullDigit(37.5).toString())
            assert.equal(alicePosition.margin.toString(), toFullDigit(300).toString())

            // then bob's position won't change
            // {balance: -187.5, margin: 1200}
            const bobPosition = await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, bob)
            assert.equal(bobPosition.size.toString(), toFullDigit(-187.5).toString())
            assert.equal(bobPosition.margin.toString(), toFullDigit(1200).toString())

            // sakePerp: 1500
            // insuranceFund: 5000
            const clearingHouseBaseToken = await quoteToken.balanceOf(this.sakePerpVault.address)
            assert.equal(clearingHouseBaseToken.toString(), (toFullDigit(11500, +(await quoteToken.decimals()))).toString())
            const insuranceFundBaseToken = await quoteToken.balanceOf(insuranceFund.address)
            assert.equal(insuranceFundBaseToken.toString(), (toFullDigit(5000, +(await quoteToken.decimals()))).toString())
        })
    })

    describe("add/remove margin", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await approve(alice, sakePerp.address, 2000)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(60), toDecimal(10), toDecimal(37.5), {
                from: alice,
            })

            const clearingHouseQuoteTokenBalance = await quoteToken.balanceOf(this.sakePerpVault.address)
            assert.equal(clearingHouseQuoteTokenBalance.toString(), (toFullDigit(10060, +(await quoteToken.decimals()))).toString())
            const allowance = await quoteToken.allowance(alice, sakePerp.address)
            assert.equal(allowance.toString(), (toFullDigit(2000 - 60, +(await quoteToken.decimals()))).toString())
        })

        it("add margin", async () => {
            const receipt = await sakePerp.addMargin(exchange.address, toDecimal(80), { from: alice })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "MarginChanged", {
                sender: alice,
                exchange: exchange.address,
                amount: toFullDigit(80),
                fundingPayment: "0",
            })
            await expectEvent.inTransaction(receipt.tx, quoteToken, "Transfer", {
                from: alice,
                to: this.sakePerpVault.address,
                value: toFullDigit(80, +(await quoteToken.decimals())),
            })
            assert.equal((await sakePerp.getPosition(exchange.address, alice)).margin.toString(), (toFullDigit(140)).toString())
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(),
                toFullDigit(140).toString(),
            )
        })

        it("remove margin", async () => {
            // remove margin 20
            const receipt = await sakePerp.removeMargin(exchange.address, toDecimal(20), {
                from: alice,
            })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "MarginChanged", {
                sender: alice,
                exchange: exchange.address,
                amount: toFullDigit(-20),
                fundingPayment: "0",
            })
            await expectEvent.inTransaction(receipt.tx, quoteToken, "Transfer", {
                from: this.sakePerpVault.address,
                to: alice,
                value: toFullDigit(20, +(await quoteToken.decimals())),
            })

            // 60 - 20
            assert.equal((await sakePerp.getPosition(exchange.address, alice)).margin.toString(), (toFullDigit(40)).toString())
            // 60 - 20
            assert.equal((await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)).toString(),
                toFullDigit(40).toString(),
            )
        })

        it("remove margin after pay funding", async () => {
            // given the underlying twap price is 25.5, and current snapShot price is 1600 / 62.5 = 25.6
            await mockPriceFeed.setTwapPrice(toFullDigit(25.5))

            // when the new fundingRate is 10% which means underlyingPrice < snapshotPrice
            await gotoNextFundingTime()
            await sakePerp.payFunding(exchange.address)
            assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(0.1)).toString())

            // remove margin 20
            const receipt = await sakePerp.removeMargin(exchange.address, toDecimal(20), {
                from: alice,
            })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "MarginChanged", {
                sender: alice,
                exchange: exchange.address,
                amount: toFullDigit(-20),
                fundingPayment: toFullDigit(3.75),
            })
        })

        it("Force error, remove margin - not enough position margin", async () => {
            // margin is 60, try to remove more than 60
            const removedMargin = 61

            await expectRevert(
                sakePerp.removeMargin(exchange.address, toDecimal(removedMargin), { from: alice }),
                "revert margin is not enough",
            )
        })

        it("Force error, remove margin - not enough ratio (4%)", async () => {
            const removedMargin = 36

            // remove margin 36
            // remain margin -> 60 - 36 = 24
            // margin ratio -> 24 / 600 = 4%
            await expectRevert(
                sakePerp.removeMargin(exchange.address, toDecimal(removedMargin), { from: alice }),
                "Margin ratio not meet criteria",
            )
        })
    })

    describe("getMarginRatio", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));
        })


        it("get margin ratio", async () => {
            await approve(alice, sakePerp.address, 2000)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            const marginRatio = await sakePerp.getMarginRatio(exchange.address, alice)
            assert.equal(marginRatio, (toFullDigit(0.1)).toString())
        })

        it("get margin ratio - long", async () => {
            await approve(alice, sakePerp.address, 2000)

            // Alice's Balance in sakePerp: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice long by 25 base token with leverage 10x
            // 25 * 10 = 250 which is x
            // (1000 + 250) * (100 + y) = 1000 * 100
            // so y = -20, quoteAsset price = 12.5

            // when Alice buy 25 long(Side.BUY) with 10 times leverage should get 20 quote tokens
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // Bob short 15 base token with leverage 10x
            // (1250 - 150) * (80 + y) = 1000 * 100
            // y = 10.9090909091
            // Bob get 10.9090909091 quote tokens
            // AMM: 1100, 90.9090909091
            await approve(bob, sakePerp.address, 2000)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // (1100 + x) * (90.9090909091 + 37.5) = 1000 * 100
            // x = 37.49999
            // alice's current unrealizedPnl is -51.639344262295081965
            // margin maintenance is around -10.6557377049180327%
            const marginRatio = await sakePerp.getMarginRatio(exchange.address, alice)
            assert.equal(marginRatio.toString(), "-134297520661157024")
        })

        it("get margin ratio - short", async () => {
            await approve(alice, sakePerp.address, 2000)
            // Alice's Balance in sakePerp: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice short by 25 base token with leverage 10x
            // 25 * 10 = 250 which is x
            // (1000 - 250) * (100 + y) = 1000 * 100
            // so y = 33.3333333333

            // when Alice buy 25 short with 10 times leverage should get 33.3333333333 quote tokens
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(25), toDecimal(10), toDecimal(33.4), {
                from: alice,
            })

            // Bob long 15 base token with leverage 10x
            // (750 + 150) * (133.3333333333 + y) = 1000 * 100
            // y = -22.222222222
            // Bob get 22.222222222 quote tokens
            // AMM: 900, 111.1111111111
            await approve(bob, sakePerp.address, 2000)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // (900 + x) * (111.1111111111 - 33.3333333333) = 1000 * 100
            // x = 385.7142857139
            // alice's current unrealizedPnl is -135.7142857139
            // margin maintenance is around -0.4428571429
            const marginRatio = await sakePerp.getMarginRatio(exchange.address, alice)
            assert.equal(marginRatio.d.toString(), "-287037037037037037")
        })

        it("get margin ratio - higher twap", async () => {
            await approve(alice, sakePerp.address, 2000)
            await approve(bob, sakePerp.address, 2000)

            const timestamp = await exchange.mock_getCurrentTimestamp()

            // Alice's Balance in sakePerp: 2000
            // (1000 + x) * (100 + y) = 1000 * 100
            //
            // Alice long by 25 base token with leverage 10x
            // 25 * 10 = 250 which is x
            // (1000 + 250) * (100 + y) = 1000 * 100
            // so y = -20, quoteAsset price = 12.5

            // when Alice buy 25 long(Side.BUY) with 10 times leverage should get 20 quote tokens
            let newTimestamp = timestamp.addn(15)
            await exchange.mock_setBlockTimestamp(newTimestamp)
            await exchange.mock_setBlockNumber(10002)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // Bob short 15 base token with leverage 10x
            // (1250 - 150) * (80 + y) = 1000 * 100
            // y = 10.9090909091
            // Bob get 10.9090909091 quote tokens
            // AMM: 1100, 90.9090909091
            newTimestamp = newTimestamp.addn(15 * 62)
            await exchange.mock_setBlockTimestamp(newTimestamp)
            await exchange.mock_setBlockNumber(10064)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // alice's current unrealized TWAP Pnl is -0.860655737704918033
            // margin maintenance is around 9.6557377049180327%
            newTimestamp = newTimestamp.addn(15)
            await exchange.mock_setBlockTimestamp(newTimestamp)
            await exchange.mock_setBlockNumber(10065)
            const marginRatio = await sakePerp.getMarginRatio(exchange.address, alice)
            assert.equal(marginRatio.d.toString(), "96890936009212041")
        })

        describe("verify margin ratio when there is funding payments", () => {
            it("when funding rate is positive", async () => {
                await approve(alice, sakePerp.address, 2000)

                // now price is 1250 / 80 = 15.625
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })

                // given the underlying twap price is 15.5
                await mockPriceFeed.setTwapPrice(toFullDigit(15.5))

                await gotoNextFundingTime()
                await sakePerp.payFunding(exchange.address)
                assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(0.125)).toString())

                // marginRatio = (margin + funding payments + unrealized Pnl) / openNotional
                // then alice need to pay 12.5% of her position size as fundingPayment which is 20 * 12.5% = 2.5
                // margin 25 --> 22.5 (margin + funding payment)
                // pnl is 0, then open notional = 250, margin ratio = 22.5 / 250 = 0.09
                const aliceMarginRatio = await sakePerpViewer.getMarginRatio(exchange.address, alice)
                assert.equal(aliceMarginRatio.toString(), toFullDigit(0.09).toString())
            })

            it("when funding rate is negative", async () => {
                await approve(alice, sakePerp.address, 2000)

                // now price is 1250 / 80 = 15.625
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })

                // given the underlying twap price is 15.7
                await mockPriceFeed.setTwapPrice(toFullDigit(15.7))

                await gotoNextFundingTime()
                await sakePerp.payFunding(exchange.address)
                assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(-0.075)).toString())

                // marginRatio = (margin + funding payments + unrealized Pnl) / openNotional
                // then alice need to pay -7.5% of her position size as fundingPayment which is 20 * -7.5% = -1.5
                // margin 25 --> 26.5 (margin + funding payment)
                // pnl is 0, then open notional = 250, margin ratio = 26.5 / 250 = 0.106
                const aliceMarginRatio = await sakePerpViewer.getMarginRatio(exchange.address, alice)
                assert.equal(aliceMarginRatio.toString(), toFullDigit(0.106).toString())
            })

            it("with pnl and funding rate is positive", async () => {
                await approve(alice, sakePerp.address, 2000)
                await approve(bob, sakePerp.address, 2000)

                // now price is 1250 / 80 = 15.625
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })
                // now price is 800 / 125 = 6.4
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(45), toDecimal(10), toDecimal(45), {
                    from: bob,
                })

                // given the underlying twap price is 6.3
                await mockPriceFeed.setTwapPrice(toFullDigit(6.3))

                await gotoNextFundingTime()
                await sakePerp.payFunding(exchange.address)
                assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(0.1)).toString())

                // marginRatio = (margin + funding payments + unrealized Pnl) / openNotional
                // then alice need to pay 10% of her position size as fundingPayment which is 20 * 10% = 2
                // margin 25 --> 23 (margin + funding payment)
                // pnl is -139.655, margin ratio = (23 + (-139.655)) / 250 = -0.466
                const pnl = await sakePerp.getPositionNotionalAndUnrealizedPnl(exchange.address, alice, 0)
                console.log(pnl[0].d.toString(), pnl[1].d.toString())
                const aliceMarginRatio = await sakePerpViewer.getMarginRatio(exchange.address, alice)
                assert.equal(aliceMarginRatio.toString(), "-1057187500000000000")

                // then bob need to pay 10% of his position size as fundingPayment which is 45 * 10% = 4.5
                // margin 45 --> 49.5 (margin + funding payment)
                // pnl is 0, margin ratio = 49.5 / 450 = 0.11
                const bobMarginRatio = await sakePerpViewer.getMarginRatio(exchange.address, bob)
                assert.equal(bobMarginRatio.toString(), toFullDigit(0.11).toString())
            })

            it("with pnl and funding rate is negative", async () => {
                await approve(alice, sakePerp.address, 2000)
                await approve(bob, sakePerp.address, 2000)

                // now price is 1250 / 80 = 15.625
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                    from: alice,
                })
                // now price is 800 / 125 = 6.4
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(45), toDecimal(10), toDecimal(45), {
                    from: bob,
                })

                // given the underlying twap price is 6.5
                await mockPriceFeed.setTwapPrice(toFullDigit(6.5))

                await gotoNextFundingTime()
                await sakePerp.payFunding(exchange.address)
                assert.equal((await sakePerp.getLatestCumulativePremiumFraction(exchange.address)).toString(), (toFullDigit(-0.1)).toString())

                // marginRatio = (margin + funding payments + unrealized Pnl) / openNotional
                // then alice need to pay 10% of her position size as fundingPayment which is 20 * -10% = -2
                // margin 25 --> 27 (margin + funding payment)
                // pnl is -139.655, margin ratio = (27 + (-139.655)) / 250 = -0.450620689655172413
                const pnl = await sakePerp.getPositionNotionalAndUnrealizedPnl(exchange.address, alice, 0)
                console.log(pnl[0].d.toString(), pnl[1].d.toString())
                const aliceMarginRatio = await sakePerpViewer.getMarginRatio(exchange.address, alice)
                assert.equal(aliceMarginRatio.toString(), "-1020937500000000000")

                // then bob need to pay -10% of his position size as fundingPayment which is 45 * -10% = 4.5
                // margin 45 --> 40.5 (margin + funding payment)
                // pnl is 0, margin ratio = 40.5 / 450 = 0.09
                const bobMarginRatio = await sakePerpViewer.getMarginRatio(exchange.address, bob)
                assert.equal(bobMarginRatio.toString(), toFullDigit(0.09).toString())
            })
        })
    })


    describe("liquidate", () => {
        let Action = {}
        Action.OPEN = 0;
        Action.CLOSE = 1;
        Action.LIQUIDATE = 2;

        beforeEach(async () => {
            console.log("insuranceFund =", (await quoteToken.balanceOf(insuranceFund.address)).toString())
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));
            await forwardBlockTimestamp(900)

            console.log("insuranceFund =", (await quoteToken.balanceOf(insuranceFund.address)).toString())
        })

        it("liquidate when the position (long) is lower than the maintenance margin", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15) // 15 secs. later
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 84.62 - 100 = -15.38
            // TWAP PnL = (70.42 * 855 + 84.62 * 15 + 99.96 * 15 + 84.62 * 15) / 900 - 100 ~= -28.61
            // Use spot price PnL since -15.38 > -28.61
            await forwardBlockTimestamp(15)
            const positionBefore = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionBefore.openNotional.toString(), (toFullDigit(100)).toString())

            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(),
                new BN("-15384615384615384623"),
            )
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.TWAP)).toString(),
                new BN("-28611412062116287475"),
            )

            // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
            // marginRatio = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
            // then anyone (eg. carol) can liquidate alice's position
            const receipt = await sakePerp.liquidate(exchange.address, alice, { from: carol })
            expectEvent(receipt, "PositionChanged", {
                exchange: exchange.address,
                trader: alice,
                positionNotional: "84615384615384615377",
                exchangedPositionSize: "-7575757575757575757",
                fee: "0",
                positionSizeAfter: "0",
                realizedPnl: "-15384615384615384623",
                fundingPayment: "0",
            })

            // verify carol get her reward
            // = positionNotional * liquidationFeeRatio = 84.62 * 0.05 = 4.231
            assert.equal((await quoteToken.balanceOf(carol)).toString(), "4230769230769230768")

            // verify alice's position got liquidate and she lost 20 DAI
            const positionAfter = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionAfter.size.toString(), "0")

            // verify alice's remaining balance
            const margin = await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), "0")
            assert.equal((await quoteToken.balanceOf(alice)).toString(), (toFullDigit(4980, +(await quoteToken.decimals()))).toString())
            // verify insuranceFund remaining
            // insuranceFundPnl = remainMargin - liquidationFee = 4.62 - 4.231 = 0.38
            // 5000 + 0.38 = 5000.384615384615384622
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(), (new BN("5000384615384615384609")).toString())
        })

        it("liquidate when the position (long) is lower than the maintenance margin but oralce price up", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15) // 15 secs. later
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 84.62 - 100 = -15.38
            // TWAP PnL = (70.42 * 855 + 84.62 * 15 + 99.96 * 15 + 84.62 * 15) / 900 - 100 ~= -28.61
            // Use spot price PnL since -15.38 > -28.61
            await forwardBlockTimestamp(15)
            const positionBefore = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionBefore.openNotional.toString(), (toFullDigit(100)).toString())

            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(),
                new BN("-15384615384615384623"),
            )
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.TWAP)).toString(),
                new BN("-28611412062116287475"),
            )

            console.log((await sakePerp.getMarginRatio(exchange.address, alice)))
            console.log((await exchange.maintenanceMarginRatio()))

            await mockPriceFeed.setTwapPrice(floatToDecimal(200).d);
            await mockPriceFeed.setPrice(floatToDecimal(200).d);


            console.log((await sakePerp.getMarginRatioBasedOnOracle(exchange.address, alice)))

            console.log((await exchange.getSpotPrice()))
            console.log((await exchange.getUnderlyingPrice()))
            console.log((await exchange.isOverSpreadLimit()))
            // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
            // marginRatio = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
            // then anyone (eg. carol) can liquidate alice's position

            await expectRevert(
                sakePerp.liquidate(exchange.address, alice, { from: carol }),
                "Margin ratio not meet criteria",
            )
        })

        it("liquidate when the position (short) is lower than the maintenance margin", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            // when bob create a 20 margin * 5x short position when 11.1111111111 quoteAsset = 100 DAI
            // AMM after: 900 : 111.1111111111

            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // when alice create a 20 margin * 5x short position when 13.8888888889 quoteAsset = 100 DAI
            // AMM after: 800 : 125
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })

            // when bob close his position
            // AMM after: 878.0487804877 : 113.8888888889
            // Bob's PnL
            // spot price Pnl = 21.951219512195121950
            // twap price Pnl = -24.583333333333333332
            // sakePerp only has 20 + 20 = 40, need to return Bob's margin 20 and PnL 21.951.
            // So, InsuranceFund to pay 1.95121..., remaining 4998.049
            await forwardBlockTimestamp(15)
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = openNotional - positionValue = 100 - 121.95 = -21.95
            // TWAP PnL = 100 - (161.29 * 855 + 128.57 * 15 + 100 * 15 + 121.95 * 15) / 900 ~= -59.06
            // Use spot price PnL since -21.95 > -59.06
            await forwardBlockTimestamp(15)
            const positionBefore = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionBefore.openNotional.toString(), toFullDigit(100).toString())
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.SPOT_PRICE)).toString(), 
                (new BN("-21951219512195121954")).toString(),
            )
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.TWAP)).toString(), 
                new BN("-59067850586339964783").toString(),
            )

            // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-21.95)) / 100 = -0.0195 < 0.05 = minMarginRatio
            // then anyone (eg. carol) can liquidate alice's position
            await sakePerp.liquidate(exchange.address, alice, { from: carol })

            // verify carol get her reward
            // = positionNotional * liquidationFeeRatio = 121.95 * 0.05 = 6.0975
            assert.equal((await quoteToken.balanceOf(carol)).toString(), "6097560975609756097")

            // verify alice's position got liquidate and she lost 20 DAI
            const positionAfter = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionAfter.size.toString(), "0")

            // verify alice's remaining balance
            const margin = await sakePerpViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice)
            assert.equal(margin.toString(), "0")

            // verify insuranceFund remaining
            // remainMargin = margin + unrealizedPnL = 20 + (-21.95121)  = -1.95121 - it's negative which means badDebt
            // insuranceFund already prepaid for alice's bad debt, so no need to withdraw for bad debt
            // insuranceFundPnl = remainMargin - liquidationFee = 0 - 6.0975 = -6.0975
            // (after closing Bob's position) 4998.049 - 6.0975 ~= 4991.9515
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(), "4991951219512195121949")
        })

        it("force error, position not liquidatable due to TWAP over maintenance margin", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(600)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 84.62 - 100 = -15.38
            // TWAP PnL = (70.42 * 270 + 84.62 * 15 + 99.96 * 600 + 84.62 * 15) / 900 - 100 ~= -9.39
            // Use TWAP price PnL since -9.39 > -15.38
            await forwardBlockTimestamp(15)
            const positionBefore = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionBefore.openNotional.toString(), toFullDigit(100).toString())
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.SPOT_PRICE)), 
                (new BN("-15384615384615384623")).toString(),
            )
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.TWAP)).toString(), 
                (new BN("-9386059949440231138")).toString(),
            )

            // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-9.39)) / 100 = 0.1061 > 0.05 = minMarginRatio
            // then anyone (eg. carol) calling liquidate() would get an exception
            await expectRevert(
                sakePerp.liquidate(exchange.address, alice, { from: carol }),
                "Margin ratio not meet criteria",
            )
        })

        it("force error, position not liquidatable due to SPOT price over maintenance margin", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: alice,
            })

            // verify alice's openNotional = 100 DAI
            // spot price PnL = positionValue - openNotional = 100 - 100 = 0
            // TWAP PnL = (83.3333333333 * 885 + 100 * 15) / 900 - 100 = -16.39
            // Use spot price PnL since 0 > -16.39
            await forwardBlockTimestamp(15)
            const positionBefore = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(positionBefore.openNotional.toString(), toFullDigit(100).toString())

            // workaround: rounding error, should be 0 but it's actually 10 wei
            const spotPnl = await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.SPOT_PRICE)
            assert.equal((new BN(spotPnl.d.toString()).divn(10)).toString(), "0")
            assert.equal((await sakePerpViewer.getUnrealizedPnl(exchange.address, alice, PnlCalcOption.TWAP)).toString(), 
                (new BN("-16388888888888888891")).toString(),
            )

            // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + 0) / 100 = 0.2 > 0.05 = minMarginRatio
            // then anyone (eg. carol) calling liquidate() would get an exception
            await expectRevert(
                sakePerp.liquidate(exchange.address, alice, { from: carol }),
                "Margin ratio not meet criteria",
            )
        })

        it("can't liquidate an empty position", async () => {
            await expectRevert(sakePerp.liquidate(exchange.address, alice, { from: carol }), "positionSize is 0")
        })

        async function openSmallPositions(
            account,
            side,
            margin,
            leverage,
            count,
        ) {
            for (let i = 0; i < count; i++) {
                await sakePerp.openPosition(exchange.address, side, margin, leverage, toDecimal(0), {
                    from: account,
                })
                await forwardBlockTimestamp(15)
            }
        }

        it("liquidate one position within the fluctuation limit", async () => {
            await exchange.setFluctuationLimitRatio(toDecimal(0.148))

            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            // alice get: 90.9090909091 - 83.3333333333 = 7.5757575758
            await openSmallPositions(alice, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // liquidate -> return base asset to AMM
            // 90.9090909091 + 7.5757575758 = 98.484848484848484854
            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            // values can be retrieved with exchange.quoteAssetReserve() & exchange.baseAssetReserve()
            const receipt = await sakePerp.liquidate(exchange.address, alice, { from: carol })
            expectEvent(receipt, "PositionLiquidated")

            const baseAssetReserve = await exchange.baseAssetReserve()
            const quoteAssetReserve = await exchange.quoteAssetReserve()
            assert.equal((parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).toString(), 98.4848)
            assert.equal((parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).toString(), 1015.38)
        })

        it("liquidate two positions within the fluctuation limit", async () => {
            await exchange.setFluctuationLimitRatio(toDecimal(0.148))
            traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await approve(carol, sakePerp.address, 100)
            // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.199), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            // actual margin ratio is 19.99...9%
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: quote = 1150
            await openSmallPositions(carol, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // when alice create a 10 margin * 5x long position
            // AMM after: quote = 1200
            await openSmallPositions(alice, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            await traderWallet1.twoLiquidations(exchange.address, alice, carol)

            const baseAssetReserve = await exchange.baseAssetReserve()
            const quoteAssetReserve = await exchange.quoteAssetReserve()
            assert.equal((parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).toString(), 98.4848)
            assert.equal((parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).toString(), 1015.38)
        })

        it("liquidate three positions within the fluctuation limit", async () => {
            await exchange.setFluctuationLimitRatio(toDecimal(0.22))
            traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await transfer(admin, relayer, 1000)
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await approve(carol, sakePerp.address, 100)
            await approve(relayer, sakePerp.address, 100)
            // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.199), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: quote = 1150 : 86.9565217391
            await openSmallPositions(carol, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // when alice create a 10 margin * 5x long position
            // AMM after: quote = 1200 : 83.3333333333
            await openSmallPositions(alice, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // when relayer create a 10 margin * 5x long position
            // AMM after: quote = 1250 : 80
            // alice + carol + relayer get: 90.9090909091 - 80 = 10.9090909091
            await openSmallPositions(relayer, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // AMM after: 1150 : 86.9565217391, price: 13.225
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // 86.9565217391 + 10.9090909091 = 97.8656126482
            // AMM after: close to 1021.8093699518 : 97.8656126482, price: 10.4409438852
            // fluctuation: (13.225 - 10.4409438852) / 13.225 = 0.2105146401
            await traderWallet1.threeLiquidations(exchange.address, alice, carol, relayer)

            const baseAssetReserve = await exchange.baseAssetReserve()
            const quoteAssetReserve = await exchange.quoteAssetReserve()
            assert.equal((parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).toString(), 97.8656)
            assert.equal((parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).toString(), 1021.8)
        })

        it("liquidates one position if the price impact of single tx exceeds the fluctuation limit ", async () => {
            await exchange.setFluctuationLimitRatio(toDecimal(0.147))

            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091
            await openSmallPositions(bob, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await openSmallPositions(alice, Side.BUY, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            expectEvent(await sakePerp.liquidate(exchange.address, alice, { from: carol }), "PositionLiquidated")
        })

        it("force error, liquidate two positions while exceeding the fluctuation limit", async () => {
            await exchange.setFluctuationLimitRatio(toDecimal(0.147))
            traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await approve(carol, sakePerp.address, 100)
            // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.199), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.BUY, toDecimal(10), toDecimal(5), 2)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1150 : 86.9565
            await openSmallPositions(carol, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // when alice create a 10 margin * 5x long position
            // AMM after: 1200 : 83.3333333, price: 14.4
            await openSmallPositions(alice, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.SELL, toDecimal(10), toDecimal(5), 2)

            // AMM after: 1015.384615384615384672 : 98.484848484848484854, price: 10.31
            // fluctuation: (12.1 - 10.31) / 10.31 = 0.1479
            await expectRevert(
                traderWallet1.twoLiquidations(exchange.address, alice, carol),
                "price is over fluctuation limit",
            )
        })

        it("force error, liquidate three positions while exceeding the fluctuation limit", async () => {
            await exchange.setFluctuationLimitRatio(toDecimal(0.21))
            traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)

            await transfer(admin, traderWallet1.address, 1000)
            await transfer(admin, bob, 1000)
            await transfer(admin, carol, 1000)
            await transfer(admin, relayer, 1000)
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)
            await approve(carol, sakePerp.address, 100)
            await approve(relayer, sakePerp.address, 100)
            // maintenance margin ratio should set 20%, but due to rounding error, below margin ratio becomes 19.99..9%
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.199), { from: admin })

            // when bob create a 20 margin * 5x long position when 9.0909090909 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909091, price: 12.1
            await openSmallPositions(bob, Side.BUY, toDecimal(10), toDecimal(5), 2)

            // when carol create a 10 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1150 : 86.9565
            await openSmallPositions(carol, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // when alice create a 10 margin * 5x long position
            // AMM after: 1200 : 83.3333333, price: 14.4
            await openSmallPositions(alice, Side.BUY, toDecimal(5), toDecimal(5), 2)

            // when relayer create a 10 margin * 5x long position
            // AMM after: quote = 1250
            await openSmallPositions(relayer, Side.BUY, toDecimal(2), toDecimal(5), 5)

            // AMM after: 1150 : 86.9565, price: 13.225
            await openSmallPositions(bob, Side.SELL, toDecimal(4), toDecimal(5), 5)

            // AMM after: close to 1021.8093699518 : 97.8656126482, price: 10.4409438852
            // fluctuation: (13.225 - 10.4409438852) / 13.225 = 0.2105146401
            await expectRevert(
                traderWallet1.threeLiquidations(exchange.address, alice, carol, relayer),
                "price is over fluctuation limit",
            )
        })

        describe("liquidator front run hack", () => {
            beforeEach(async () => {
                await transfer(admin, carol, 1000)
                await approve(alice, sakePerp.address, 1000)
                await approve(bob, sakePerp.address, 1000)
                await approve(carol, sakePerp.address, 1000)
                await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })
            })

            async function makeAliceLiquidatableByShort() {
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                    from: bob,
                })
                await forwardBlockTimestamp(15)
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                    from: alice,
                })
                await forwardBlockTimestamp(15)
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                    from: bob,
                })
                await forwardBlockTimestamp(15)
                // remainMargin = (margin + unrealizedPnL) = 20 - 15.38 = 4.62
                // marginRatio of alice = remainMargin / openNotional = 4.62 / 100 = 0.0462 < minMarginRatio(0.05)
            }

            async function makeAliceLiquidatableByLong() {
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: bob,
                })
                await forwardBlockTimestamp(15)
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: alice,
                })
                await forwardBlockTimestamp(15)
                await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })
                await forwardBlockTimestamp(15)
                // marginRatio = (margin + unrealizedPnL) / openNotional = (20 + (-21.95)) / 100 = -0.0195 < 0.05 = minMarginRatio
            }

            it("liquidator can open position and liquidate in the next block", async () => {
                await makeAliceLiquidatableByShort()

                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: carol,
                })
                await forwardBlockTimestamp(15)
                expectEvent(await sakePerp.liquidate(exchange.address, alice, { from: carol }), "PositionLiquidated")
            })

            it("can open position (short) and liquidate, but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByShort()

                // short to make alice loss more and make insuranceFund loss more
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: carol,
                })
                await sakePerp.liquidate(exchange.address, alice, { from: carol })
                await expectRevert(
                    sakePerp.closePosition(exchange.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("can open position (long) and liquidate, but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByLong()

                // short to make alice loss more and make insuranceFund loss more
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: carol,
                })
                await sakePerp.liquidate(exchange.address, alice, { from: carol })
                await expectRevert(
                    sakePerp.closePosition(exchange.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("can open position and liquidate, but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByShort()

                // open a long position, make alice loss less
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(1), toDecimal(0), {
                    from: carol,
                })
                await sakePerp.liquidate(exchange.address, alice, { from: carol })
                await expectRevert(
                    sakePerp.closePosition(exchange.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("can open position (even the same side, short), but can't do anything more action in the same block", async () => {
                await makeAliceLiquidatableByLong()

                // open a short position, make alice loss less
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(1), toDecimal(0), {
                    from: carol,
                })
                await sakePerp.liquidate(exchange.address, alice, { from: carol })
                await expectRevert(
                    sakePerp.closePosition(exchange.address, toDecimal(0), { from: carol }),
                    "only one action allowed",
                )
            })

            it("liquidator can't open and liquidate position in the same block, even from different msg.sender", async () => {
                await transfer(admin, carol, 1000)
                await approve(alice, sakePerp.address, 1000)
                await approve(bob, sakePerp.address, 1000)
                await approve(carol, sakePerp.address, 1000)
                await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

                traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)
                traderWallet2 = await TraderWallet.new(sakePerp.address, quoteToken.address)

                await approve(alice, traderWallet1.address, 500)
                await approve(alice, traderWallet2.address, 500)
                await transfer(alice, traderWallet1.address, 500)
                await transfer(alice, traderWallet2.address, 500)

                await makeAliceLiquidatableByShort()
                await traderWallet1.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: bob,
                })
                await traderWallet2.liquidate(exchange.address, alice, { from: bob })
                await expectRevert(traderWallet1.closePosition(exchange.address, { from: bob }), "only one action allowed")
            })

            it("liquidator can't open and liquidate position in the same block, even from different tx.origin", async () => {
                await transfer(admin, carol, 1000)
                await approve(alice, sakePerp.address, 1000)
                await approve(bob, sakePerp.address, 1000)
                await approve(carol, sakePerp.address, 1000)
                await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

                traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)
                traderWallet2 = await TraderWallet.new(sakePerp.address, quoteToken.address)

                await approve(alice, traderWallet1.address, 500)
                await approve(alice, traderWallet2.address, 500)
                await transfer(alice, traderWallet1.address, 500)
                await transfer(alice, traderWallet2.address, 500)

                await makeAliceLiquidatableByShort()
                await traderWallet1.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(0), {
                    from: bob,
                })
                await traderWallet2.liquidate(exchange.address, alice, { from: carol })
                await expectRevert(traderWallet1.closePosition(exchange.address, { from: admin }), "only one action allowed")
            })
        })
    })

    describe("sakePerp", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await approve(alice, sakePerp.address, 100)
            const clearingHouseBaseTokenBalance = await quoteToken.allowance(alice, sakePerp.address)
            assert.equal(clearingHouseBaseTokenBalance.toString(), toFullDigit(100, +(await quoteToken.decimals())).toString())
        })


        it("sakePerp should have enough balance after close position", async () => {
            await approve(bob, sakePerp.address, 200)

            // AMM after: 900 : 111.1111111111
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // AMM after: 800 : 125
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(25), toDecimal(4), toDecimal(13.89), {
                from: alice,
            })
            // 20(bob's margin) + 25(alice's margin) = 45
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(), 
                toFullDigit(10045, +(await quoteToken.decimals())).toString(),
            )

            // when bob close his position (11.11)
            // AMM after: 878.0487804877 : 113.8888888889
            // Bob's PnL = 21.951219512195121950
            // need to return Bob's margin 20 and PnL 21.951 = 41.951
            // sakePerp balance: 45 - 41.951 = 3.048...
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(), 
                toFullDigit(5000, +(await quoteToken.decimals())).toString(),
            )
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(), "10003048780487804878055")
        })

        it("sakePerp doesn't have enough balance after close position and ask for InsuranceFund", async () => {
            await approve(bob, sakePerp.address, 200)

            // AMM after: 900 : 111.1111111111
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // AMM after: 800 : 125
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })
            // 20(bob's margin) + 20(alice's margin) = 40
            assert.equal((await quoteToken.balanceOf(this.sakePerpVault.address)).toString(), 
                (toFullDigit(10040, +(await quoteToken.decimals()))).toString(),
            )

            // when bob close his position (11.11)
            // AMM after: 878.0487804877 : 113.8888888889
            // Bob's PnL = 21.951219512195121950
            // need to return Bob's margin 20 and PnL 21.951 = 41.951
            // sakePerp balance: 40 - 41.951 = -1.95...
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })
            assert.equal((await quoteToken.balanceOf(insuranceFund.address)).toString(), "5000000000000000000000")
        })
    })

    describe("close position slippage limit", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await forwardBlockTimestamp(900)
        })

        // Case 1
        it("closePosition, originally long, (amount should pay = 118.03279) at the limit of min quote amount = 118", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            // when bob create a 20 margin * 5x short position when 9.0909091 quoteAsset = 100 DAI
            // AMM after: 1100 : 90.9090909
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9), {
                from: bob,
            })

            // when alice create a 20 margin * 5x short position when 7.5757609 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.5), {
                from: alice,
            })

            // when bob close his position
            // AMM after: 1081.96721 : 92.4242424
            await forwardBlockTimestamp(15)
            await sakePerp.closePosition(exchange.address, toDecimal(118), { from: bob })

            const quoteAssetReserve = await exchange.quoteAssetReserve()
            const baseAssetReserve = await exchange.baseAssetReserve()
            assert.equal((parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 100).toString(), 1081.96)
            assert.equal((parseFloat(baseAssetReserve.toString().substr(0, 6)) / 10000).toString(), 92.4242)
        })

        // Case 2
        it("closePosition, originally short, (amount should pay = 78.048) at the limit of max quote amount = 79", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            // when bob create a 20 margin * 5x short position when 11.1111111111 quoteAsset = 100 DAI
            // AMM after: 900 : 111.1111111111
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            // when alice create a 20 margin * 5x short position when 13.8888888889 quoteAsset = 100 DAI
            // AMM after: 800 : 125
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })

            // when bob close his position
            // AMM after: 878.0487804877 : 113.8888888889
            await forwardBlockTimestamp(15)
            await sakePerp.closePosition(exchange.address, toDecimal(79), { from: bob })

            const quoteAssetReserve = await exchange.quoteAssetReserve()
            const baseAssetReserve = await exchange.baseAssetReserve()
            assert.equal((parseFloat(quoteAssetReserve.toString().substr(0, 6)) / 1000).toString(), 878.048)
            assert.equal((parseFloat(baseAssetReserve.toString().substr(0, 6)) / 1000).toString(), 113.888)
        })

        // expectRevert section
        // Case 1
        it("force error, closePosition, originally long, less than min quote amount = 119", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9), {
                from: bob,
            })

            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.5), {
                from: alice,
            })

            await forwardBlockTimestamp(15)
            await expectRevert(
                sakePerp.closePosition(exchange.address, toDecimal(119), { from: bob }),
                "Less than minimal quote token",
            )
        })

        // Case 2
        it("force error, closePosition, originally short, more than max quote amount = 78", async () => {
            await approve(alice, sakePerp.address, 100)
            await approve(bob, sakePerp.address, 100)

            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(11.12), {
                from: bob,
            })

            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(13.89), {
                from: alice,
            })

            await forwardBlockTimestamp(15)
            await expectRevert(
                sakePerp.closePosition(exchange.address, toDecimal(78), { from: bob }),
                "More than maximal quote token",
            )
        })
    })

    describe("migrate liquidity", () => {
        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            await transfer(admin, carol, 5000)

            await approve(alice, sakePerp.address, 2000)
            await approve(bob, sakePerp.address, 2000)
            await approve(carol, sakePerp.address, 2000)
        })

        it("add liquidity with positive position size", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })

            // baseReserve = 83.33...
            // quoteReserve = 1200
            // new baseReserve = 166.66
            // new quoteReserve = 2400
            const receipt = await exchange.migrateLiquidity(toDecimal(2), toDecimal(0), { from: admin })
            expectEvent(receipt, "LiquidityChanged", {
                cumulativeNotional: toFullDigit(200),
            })
            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "15151515151515151515")

            const newBaseReserve = await exchange.baseAssetReserve()
            const newQuoteReserve = await exchange.quoteAssetReserve()
            assert.equal(newBaseReserve.toString(), "166666666666666666668")
            assert.equal(newQuoteReserve.toString(), toFullDigit(2400).toString())

            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), "8620689655172413793")
            const posBob = await sakePerp.getPosition(exchange.address, bob)
            assert.equal(posBob.size.toString(), "12903225806451612904")
            const posCarol = await sakePerp.getPosition(exchange.address, carol)
            assert.equal(posCarol.size.toString(), "-6666666666666666667")
        })

        it("add liquidity with negative position size", async () => {
            // alice position: -11.11
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -31.74
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // total position = -42.85
            // baseReserve = 142.85
            // quoteReserve = 700
            // new baseReserve = 285.71
            // new quoteReserve = 1400
            const receipt = await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            const newBaseReserve = await exchange.baseAssetReserve()
            const newQuoteReserve = await exchange.quoteAssetReserve()
            assert.equal(newBaseReserve.toString(), "285714285714285714288")
            assert.equal(newQuoteReserve.toString(), toFullDigit(1400).toString())

            expectEvent(receipt, "LiquidityChanged", {
                cumulativeNotional: toFullDigit(-300),
            })

            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "-50420168067226890757")

            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), "-11560693641618497111")
            const posBob = await sakePerp.getPosition(exchange.address, bob)
            assert.equal(posBob.size.toString(), "-35714285714285714286")
        })

        it("add liquidity with position size is zero", async () => {
            // alice position: 9.09
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -9.09
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // total position = 0
            // baseReserve = 100
            // quoteReserve = 1000
            // new baseReserve = 200
            // new quoteReserve = 2000
            const receipt = await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            const newBaseReserve = await exchange.baseAssetReserve()
            const newQuoteReserve = await exchange.quoteAssetReserve()
            assert.equal(newBaseReserve.toString(), "200000000000000000002")
            assert.equal(newQuoteReserve.toString(), toFullDigit(2000).toString())

            expectEvent(receipt, "LiquidityChanged", {
                cumulativeNotional: "0",
            })

            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "-1")

            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), "8695652173913043479")
            const posBob = await sakePerp.getPosition(exchange.address, bob)
            assert.equal(posBob.size.toString(), "-9523809523809523810")
        })

        it("add liquidity and open a new position to update existing ones", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // total position = 9.09
            // baseReserve = 90.909
            // quoteReserve = 1100
            const migrateReceipt = await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            expectEvent(migrateReceipt, "LiquidityChanged", {
                cumulativeNotional: toFullDigit(100),
            })

            // new baseReserve = 181.818
            // new quoteReserve = 2200
            // position size: 7.905
            const receipt = await sakePerp.openPosition(
                exchange.address,
                Side.BUY,
                toDecimal(10),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )
            await expectEvent.inTransaction(receipt.tx, sakePerp, "PositionAdjusted", {
                exchange: exchange.address,
                trader: alice,
                newPositionSize: "8658008658008658009",
            })

            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "8658008658008658009")

            const pos = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(pos.size.toString(), "16563146997929606625")
        })

        it("add liquidity twice", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // total position = 9.09
            // baseReserve = 90.909
            // quoteReserve = 1100
            // new baseReserve = 181.818
            // new quoteReserve = 2200
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            // new baseReserve = 363.636
            // new quoteReserve = 4400
            const receipt = await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            expectEvent(receipt, "LiquidityChanged", {
                cumulativeNotional: toFullDigit(100).toString(),
            })

            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), "8456659619450317125")

            // position size: 8.08..
            const receipt2 = await sakePerp.openPosition(
                exchange.address,
                Side.BUY,
                toDecimal(10),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )
            await expectEvent.inTransaction(receipt2.tx, sakePerp, "PositionAdjusted", {
                exchange: exchange.address,
                trader: alice,
                newPositionSize: posAlice.size.d,
            })

            const pos = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(pos.size.toString(), "16537467700258397933")
        })

        it("add liquidity twice, double then half", async () => {
            // given alice opens position with 250 quoteAsset for 20 baseAsset
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(20), {
                from: alice,
            })

            // when double the liquidity
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            let liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "17777777777777777778")

            // when half the liquidity
            await exchange.migrateLiquidity(toDecimal(0.5), toDecimal(0))
            liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(2)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "20000000000000000001")

            // then alice.position should be the same - with rounding error
            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), toFullDigit(20).toString())
        })

        it("still able to migrate liquidity without any position opened", async () => {
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.cumulativeNotional.toString(), "0")
        })

        it("should be able to add liquidity even there is no outstanding position", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(1), toDecimal(0), {
                from: carol,
            })
            const pos = await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, carol)
            const p = await exchange.getOutputPrice(Dir.ADD_TO_AMM, pos.size)
            await sakePerp.openPosition(exchange.address, Side.SELL, p, toDecimal(1), toDecimal(0), {
                from: bob,
            })

            // when double the liquidity
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "0") // totalPositionSize
        })

        it("open position, add liquidity then close position", async () => {
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // when double the liquidity
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            // alice close
            await sakePerp.closePosition(exchange.address, toDecimal(0), {
                from: alice,
            })
            assert.equal((await sakePerpViewer.getPersonalPositionWithFundingPayment(exchange.address, alice)).size.toString(), "0")
        })

        it("open position after adding liquidity, then add liquidity", async () => {
            // when double the liquidity
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            // then alice open position
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // then alice can get her entire margin (250) back if she close her position
            const alicePreBalance = await quoteToken.balanceOf(alice)
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })
            const alicePostBalance = await quoteToken.balanceOf(alice)
            assert.equal(alicePostBalance.sub(alicePreBalance).toString(), "24999999999999999997")
        })

        it("should return equal quote amount after migrate liquidity", async () => {
            // given bob open a position at first
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // when double the liquidity
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            // then alice open position
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(25), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // then half the liquidity
            await exchange.migrateLiquidity(toDecimal(0.5), toDecimal(0))

            // then alice can get her entire margin (250) back if she close her position
            const alicePreBalance = await quoteToken.balanceOf(alice)
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })
            const alicePostBalance = await quoteToken.balanceOf(alice)

            // then alice can get her entire margin (250) back if she close her position
            assert.equal(alicePostBalance.sub(alicePreBalance).toString(), "24999999999999999997")
        })

        it("add liquidity and liquidity ratio is less than 1", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })

            // total position = 16.66...
            // baseReserve = 83.33...
            // quoteReserve = 1200
            // new baseReserve = 41.666
            // new quoteReserve = 600
            await exchange.migrateLiquidity(toDecimal(0.5), toDecimal(0))
            const liquidityChangedSnapshot = await exchange.getLiquidityChangedSnapshots(1)
            assert.equal(liquidityChangedSnapshot.totalPositionSize.toString(), "20833333333333333333")

            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), "10204081632653061225")
            const posBob = await sakePerp.getPosition(exchange.address, bob)
            assert.equal(posBob.size.toString(), "16806722689075630253")
            const posCarol = await sakePerp.getPosition(exchange.address, carol)
            assert.equal(posCarol.size.toString(), "-5952380952380952381")
        })

        it("add liquidity position notional should be the same", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })
            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            const posBob = await sakePerp.getPosition(exchange.address, bob)
            const posCarol = await sakePerp.getPosition(exchange.address, carol)

            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0), { from: admin })

            const posAlice1 = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.openNotional.toString(), posAlice1.openNotional.toString())
            const posBob1 = await sakePerp.getPosition(exchange.address, bob)
            assert.equal(posBob.openNotional.toString(), posBob1.openNotional.toString())
            const posCarol1 = await sakePerp.getPosition(exchange.address, carol)
            assert.equal(posCarol.openNotional.toString(), posCarol1.openNotional.toString())
        })

        it("add liquidity and margin ratio should the same if no one trades", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            const ratio1 = await sakePerp.getMarginRatio(exchange.address, alice)
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0), { from: admin })
            const ratio2 = await sakePerp.getMarginRatio(exchange.address, alice)
            // ratio and ratio2 should be the same, but rounding issue...
            assert.equal(ratio1.toString(), "99999999999999999")
            assert.equal(ratio2.toString(), toFullDigit(0.1).toString())
        })

        it("add liquidity and close position", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            const posMigrated = await sakePerp.getPosition(exchange.address, alice)

            const r = await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })
            await expectEvent.inTransaction(r.tx, sakePerp, "PositionChanged", {
                exchangedPositionSize: new BN(posMigrated.size.d).mul(new BN("-1")),
            })

            const posClosed = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posClosed.size.toString(), "0")
        })

        it("add liquidity and open a reverse but smaller position size", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -4.228,
            // new position size will be 8.658 - 4.228 ~= 4.43
            const receipt = await sakePerp.openPosition(
                exchange.address,
                Side.SELL,
                toDecimal(5),
                toDecimal(10),
                toDecimal(0),
                { from: alice },
            )

            const pos = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(pos.size.toString(), "4429678848283499446")
        })

        it("add liquidity and open a larger reverse position", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -13.3,
            // new position size will be 8.658 - 13.3 ~= -4.64
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(15), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            const pos = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(pos.size.toString(), "-4645760743321718932")
        })

        it("add liquidity and liquidate", async () => {
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.1), { from: admin })

            // AMM after: 1100 : 90.9090909091
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(9.09), {
                from: bob,
            })

            // when alice create a 20 margin * 5x long position when 7.5757575758 quoteAsset = 100 DAI
            // AMM after: 1200 : 83.3333333333
            await forwardBlockTimestamp(15) // 15 secs. later
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(5), toDecimal(7.57), {
                from: alice,
            })

            // when bob sell his position 7.575, remaining position 1.515
            // AMM after: 1100 : 90.9090909091
            await forwardBlockTimestamp(15)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(5), toDecimal(7.58), {
                from: bob,
            })

            // alice's migrated position size = 7.21
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            const pos = await sakePerp.getPosition(exchange.address, alice)
            assert.notEqual(pos.size.toString(), "0")
        })

        it("add liquidity and add margin", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -13.3,
            // new position size will be 8.658 - 13.3 ~= -4.64
            const receipt = await sakePerp.addMargin(exchange.address, toDecimal(10), { from: alice })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "8658008658008658009",
            })
        })

        it("add liquidity and remove margin", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            // new baseReserve = 181.818
            // new quoteReserve = 2200

            // position size: -13.3,
            // new position size will be 8.658 - 13.3 ~= -4.64
            const receipt = await sakePerp.addMargin(exchange.address, toDecimal(5), { from: alice })
            await expectEvent.inTransaction(receipt.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "8658008658008658009",
            })
        })

        it("add liquidity, close position and then open position, liquidity changed index should be new", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            // migrated position size = 8.658
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
        })

        //because of rounding issue the result is a few wei different compare to expected results
        it("add liquidity and its positionNotional and unrealizedPnl should the same if no one trades", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })

            const positionNotionalAndUnrealizedPnl = await sakePerp.getPositionNotionalAndUnrealizedPnl(
                exchange.address,
                alice,
                PnlCalcOption.SPOT_PRICE,
            )
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0), { from: admin })
            const positionNotionalAndUnrealizedPnl2 = await sakePerp.getPositionNotionalAndUnrealizedPnl(
                exchange.address,
                alice,
                PnlCalcOption.SPOT_PRICE,
            )
            // positionNotionalAndUnrealizedPnl and positionNotionalAndUnrealizedPnl2 should be the same
            assert.equal(((new BN(positionNotionalAndUnrealizedPnl[1].d)).add(new BN(1)).div(new BN(10))).toString(), (
                (new BN(positionNotionalAndUnrealizedPnl2[1].d)).add(new BN(1)).divn(new BN(10))).toString(),
            )
            assert.equal(((new BN(positionNotionalAndUnrealizedPnl[0].d)).add(new BN(1)).div(new BN(10))).toString(), (
                (new BN(positionNotionalAndUnrealizedPnl2[0].d)).add(new BN(1)).div(new BN(10))).toString(),
            )
        })

        it("position changes if someone open/close earlier", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -9.090
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            const posAlice = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posAlice.size.toString(), "8695652173913043479")

            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })

            // alice's position changes if others open positions
            const posClosed = await sakePerp.getPosition(exchange.address, alice)
            assert.equal(posClosed.size.toString(), "9523809523809523810")
        })

        it("check Pnl after liquidity migration", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -9.090
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))

            const r = await sakePerp.closePosition(exchange.address, toDecimal(0), { from: alice })
            expectEvent.inTransaction(r.tx, sakePerp, "PositionChanged", { realizedPnl: "-16666666666666666661" })

            const bobPnl = await sakePerp.getPositionNotionalAndUnrealizedPnl(
                exchange.address,
                bob,
                PnlCalcOption.SPOT_PRICE,
            )
            assert.equal(bobPnl[1].d.toString(), "16666666666666666660")
        })

        it("migration attack, open a huge position right before migration", async () => {
            // alice position: -4.76
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(5), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -10
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // carol position: -894.74
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(85), toDecimal(10), toDecimal(0), {
                from: carol,
            })
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            const p = await sakePerp.getPosition(exchange.address, carol)
            console.log(p.size.d.toString())

            const r = await sakePerp.closePosition(exchange.address, toDecimal(0), { from: carol })
            expectEvent.inTransaction(r.tx, sakePerp, "PositionChanged", {
                realizedPnl: "-137",
                exchangedPositionSize: "1619047619047619047696",
            })
        })

        it("adjust position after adding liquidity with positive position size", async () => {
            // alice position: 9.090
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: 13.986
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })
            // carol position: -6.41
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: carol,
            })

            // baseReserve = 83.33...
            // quoteReserve = 1200
            // new baseReserve = 166.66
            // new quoteReserve = 2400
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0), { from: admin })
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, alice)), true)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, bob)), true)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, carol)), true)

            const receiptAlice = await sakePerp.adjustPosition(exchange.address, { from: alice })
            await expectEvent.inTransaction(receiptAlice.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "8620689655172413793",
            })
            const receiptBob = await sakePerp.adjustPosition(exchange.address, { from: bob })
            await expectEvent.inTransaction(receiptBob.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "12903225806451612904",
            })
            const receiptCarol = await sakePerp.adjustPosition(exchange.address, { from: carol })
            await expectEvent.inTransaction(receiptCarol.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "-6666666666666666667",
            })

            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, alice)), false)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, bob)), false)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, carol)), false)
        })

        it("adjust position after adding liquidity with negative position size", async () => {
            // alice position: -11.11
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -31.74
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // total position = -42.85
            // baseReserve = 142.85
            // quoteReserve = 700
            // new baseReserve = 285.71
            // new quoteReserve = 1400
            await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, alice)), true)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, bob)), true)

            const receiptAlice = await sakePerp.adjustPosition(exchange.address, { from: alice })
            await expectEvent.inTransaction(receiptAlice.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "-11560693641618497111",
            })
            const receiptBob = await sakePerp.adjustPosition(exchange.address, { from: bob })
            await expectEvent.inTransaction(receiptBob.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "-35714285714285714286",
            })

            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, alice)), false)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, bob)), false)
        })

        it("adjust position after adding liquidity with position size is zero", async () => {
            // alice position: 9.09
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            // bob position: -9.09
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(10), toDecimal(0), {
                from: bob,
            })

            // total position = 0
            // baseReserve = 100
            // quoteReserve = 1000
            // new baseReserve = 200
            // new quoteReserve = 2000
            const receipt = await exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, alice)), true)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, bob)), true)

            const receiptAlice = await sakePerp.adjustPosition(exchange.address, { from: alice })
            await expectEvent.inTransaction(receiptAlice.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "8695652173913043479",
            })
            const receiptBob = await sakePerp.adjustPosition(exchange.address, { from: bob })
            await expectEvent.inTransaction(receiptBob.tx, sakePerp, "PositionAdjusted", {
                newPositionSize: "-9523809523809523810",
            })

            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, alice)), false)
            assert.equal((await sakePerpViewer.isPositionNeedToBeMigrated(exchange.address, bob)), false)
        })

        // AMM quote : base = 1000 : 100
        describe("limitation of reducing liquidity", () => {
            it("(short) can reduce liquidity when above the limit", async () => {
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(200), toDecimal(1), toDecimal(0), {
                    from: alice,
                })
                // Amm reserve : 800 : 125
                // total position size = -25, baseAssetDelta = 25
                // limit should be (25 + 1g wei) / 125 ~= 0.20+
                const r = await exchange.migrateLiquidity(toDecimal("0.21"), toDecimal(0))
                await expectEvent.inTransaction(r.tx, exchange, "LiquidityChanged")

                // Amm reserves are around 168 : 26.25
                await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(1), toDecimal(1), toDecimal(0), {
                    from: alice,
                })

                const r2 = await exchange.migrateLiquidity(toDecimal(10), toDecimal(0))
                await expectEvent.inTransaction(r2.tx, exchange, "LiquidityChanged")
            })

            it("(long) can reduce liquidity when above the limit", async () => {
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(250), toDecimal(1), toDecimal(0), {
                    from: alice,
                })
                // Amm reserve : 1250 : 80
                // total position size = 20
                // limit should be (20 + 1gwei) / 80 ~= 0.25+
                const r = await exchange.migrateLiquidity(toDecimal("0.26"), toDecimal(0))
                await expectEvent.inTransaction(r.tx, exchange, "LiquidityChanged")
            })

            it("(long) can not reduce liquidity when under the limit", async () => {
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(250), toDecimal(1), toDecimal(0), {
                    from: alice,
                })
                // Amm reserve : 1250 : 80
                // total position size = 20
                // limit should be (20 + 1gwei) / 80 ~= 0.25+
                await expectRevert(
                    exchange.migrateLiquidity(toDecimal("0.25"), toDecimal(0)),
                    "illegal liquidity multiplier",
                )
            })

            it("(long) no upper bound when increase liquidity", async () => {
                await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(250), toDecimal(1), toDecimal(0), {
                    from: alice,
                })
                const r = await exchange.migrateLiquidity(toDecimal("100"), toDecimal(0))
                await expectEvent.inTransaction(r.tx, exchange, "LiquidityChanged")
            })
        })
    })

    describe("pausable functions", () => {
        it("pause by admin", async () => {
            const error = "Pausable: paused"
            await sakePerp.pause(true)
            await expectRevert(
                sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(1), toDecimal(1), toDecimal(0)),
                error,
            )
            await expectRevert(sakePerp.addMargin(exchange.address, toDecimal(1)), error)
            await expectRevert(sakePerp.removeMargin(exchange.address, toDecimal(1)), error)
            await expectRevert(sakePerp.closePosition(exchange.address, toDecimal(0)), error)
        })

        it("can't pause by non-admin", async () => {
            await expectRevert(sakePerp.pause(true, { from: alice }), "Ownable: caller is not the owner")
        })

        it("pause then unpause by admin", async () => {
            await quoteToken.approve(sakePerp.address, toFullDigit(2), { from: alice })
            await sakePerp.pause(true)
            await sakePerp.pause(false)
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(1), toDecimal(1), toDecimal(0), {
                from: alice,
            })
            await sakePerp.addMargin(exchange.address, toDecimal(1), {
                from: alice,
            })
            await sakePerp.removeMargin(exchange.address, toDecimal(1), {
                from: alice,
            })
            await sakePerp.closePosition(exchange.address, toDecimal(0), {
                from: alice,
            })
        })

        it("pause by admin and can not being paused by non-admin", async () => {
            await sakePerp.pause(true)
            await expectRevert(sakePerp.pause(true, { from: alice }), "Ownable: caller is not the owner")
        })
    })

    describe("restriction mode", () => {
        let Action = {}
        Action.OPEN = 0,
        Action.CLOSE = 1,
        Action.LIQUIDATE = 2,

        beforeEach(async () => {
            await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
            await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));

            traderWallet1 = await TraderWallet.new(sakePerp.address, quoteToken.address)
            await transfer(admin, traderWallet1.address, 1000)

            await approve(admin, sakePerp.address, 1000)
            await approve(alice, sakePerp.address, 1000)
            await approve(bob, sakePerp.address, 1000)
            await this.exchangeState.setMaintenanceMarginRatio(toDecimal(0.2))
        })

        it("trigger restriction mode", async () => {
            // just make some trades to make bob's bad debt larger than 0 by checking args[8] of event
            // price become 11.03 after openPosition
            await sakePerp.openPosition(exchange.address, Side.BUY, toDecimal(10), toDecimal(5), toDecimal(0), {
                from: bob,
            })
            await forwardBlockTimestamp(15)
            // price become 7.23 after openPosition
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(20), toDecimal(10), toDecimal(0), {
                from: alice,
            })
            await forwardBlockTimestamp(15)
            await sakePerp.closePosition(exchange.address, toDecimal(0), { from: bob })

            const blockNumber = await sakePerp.mock_getCurrentBlockNumber()
            assert.equal((await sakePerp.isInRestrictMode(exchange.address, blockNumber)), true)
            assert.equal((await sakePerp.isInRestrictMode(exchange.address, blockNumber- 1)), false)
        })

        // there are 3 types of actions, open, close and liquidate
        // So test cases will be combination of any two of them,
        // except close-close because it doesn't make sense.
        it("open then close", async () => {
            await expectRevert(
                traderWallet1.multiActions(
                    Action.OPEN,
                    true,
                    Action.CLOSE,
                    exchange.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("open then open", async () => {
            await expectRevert(
                traderWallet1.multiActions(
                    Action.OPEN,
                    true,
                    Action.OPEN,
                    exchange.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("open then liquidate", async () => {
            await makeLiquidatableByShort(alice)
            await sakePerp.liquidate(exchange.address, alice)
        })

        it("liquidate then open", async () => {
            await makeLiquidatableByShort(alice)
            await forwardBlockTimestamp(15)
            await traderWallet1.multiActions(
                Action.LIQUIDATE,
                true,
                Action.OPEN,
                exchange.address,
                Side.BUY,
                toDecimal(60),
                toDecimal(10),
                toDecimal(0),
                alice,
            )
        })

        it("failed if open, liquidate then close", async () => {
            await makeLiquidatableByShort(alice)
            await forwardBlockTimestamp(15)
            await traderWallet1.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(5), toDecimal(0))
            await expectRevert(
                traderWallet1.multiActions(
                    Action.LIQUIDATE,
                    true,
                    Action.CLOSE,
                    exchange.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("liquidate then liquidate", async () => {
            await makeLiquidatableByShort(alice)
            await makeLiquidatableByShort(bob)
            await forwardBlockTimestamp(15)
            await expectRevert(
                traderWallet1.multiActions(
                    Action.LIQUIDATE,
                    true,
                    Action.LIQUIDATE,
                    exchange.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "positionSize is 0",
            )
        })

        it("close then liquidate", async () => {
            await makeLiquidatableByShort(alice)
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(1), toDecimal(0), {
                from: bob,
            })
            await forwardBlockTimestamp(15)
            await sakePerp.closePosition(exchange.address, toDecimal(0))
            await sakePerp.liquidate(exchange.address, alice)
        })

        it("failed when close then liquidate then open", async () => {
            await makeLiquidatableByShort(alice)
            await traderWallet1.openPosition(exchange.address, Side.SELL, toDecimal(10), toDecimal(5), toDecimal(0))
            await forwardBlockTimestamp(15)
            await traderWallet1.closePosition(exchange.address)
            await expectRevert(
                traderWallet1.multiActions(
                    Action.LIQUIDATE,
                    true,
                    Action.OPEN,
                    exchange.address,
                    Side.BUY,
                    toDecimal(60),
                    toDecimal(10),
                    toDecimal(0),
                    alice,
                ),
                "only one action allowed",
            )
        })

        it("close then open", async () => {
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(1), toDecimal(1), toDecimal(0))
            await forwardBlockTimestamp(15)
            await sakePerp.closePosition(exchange.address, toDecimal(0))
            await sakePerp.openPosition(exchange.address, Side.SELL, toDecimal(1), toDecimal(1), toDecimal(0))
        })
    })
})

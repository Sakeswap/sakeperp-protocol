const { BN, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const Exchange = artifacts.require('ExchangeFake');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const SakePerp = artifacts.require('SakePerp');
const SakePerpViewer = artifacts.require('SakePerpViewer');
const SakePerpVault = artifacts.require('SakePerpVault');
const SakePerpState = artifacts.require('SakePerpState');
const SystemSettings = artifacts.require('SystemSettings');
const InsuranceFund = artifacts.require('InsuranceFund');
const ERC20Token = artifacts.require('ERC20Token');
const { toDecimal, toFullDigitStr, toFullDigit, fromDecimal } = require('./helper/number');
const { Side, Dir, PnlCalcOption } = require('./helper/contract');
const { utils } = require("ethers");

contract('Scenario', ([alice, t1, t2, t3, t4, t5, t6]) => {
    beforeEach(async () => {
        this.priceFeedKey = utils.formatBytes32String('ETH')
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigitStr("10000000000"))
        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10))
        
        this.SakePerp = await SakePerp.new()
        this.SakePerpVault = await SakePerpVault.new()
        this.systemSettings = await SystemSettings.new()
        this.insuraceFund = await InsuranceFund.new()
        this.SakePerpState = await SakePerpState.new()
        this.exchangeState = await ExchangeState.new()
        this.sakePerpViewer = await SakePerpViewer.new()

        this.sakePerpViewer.initialize(this.SakePerp.address, this.systemSettings.address)

        this.exchange = await Exchange.new(
            toFullDigitStr("10000"),  // quoteAssetReserve
            toFullDigitStr("1000"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            this.priceFeed.address,   // priceFeed 
            this.SakePerp.address,         // SakePerp
            this.SakePerpVault.address,    // minter
            this.priceFeedKey,        // priceFeedKey
            this.quoteAsset.address,  // quoteAsset
            0,                        // fluctuationLimitRatio
            toFullDigitStr("1"),      // priceAdjustRatio
            this.exchangeState.address
        )
        await this.exchange.fakeInitialize()
        await this.exchangeState.initialize(
            this.exchange.address,
            toFullDigitStr("0"),
            toFullDigitStr("0.1"),
            toFullDigitStr("0.03"),
            toFullDigitStr("0.01"),
            toFullDigitStr("100"),
            toFullDigitStr("0.1"),
            this.systemSettings.address
        )

        // this.exchange = await Exchange.new(
        //     "7617075949344040831327709",  // quoteAssetReserve
        //     "19113266162527567053401",    // baseAssetReserve
        //     toFullDigitStr("0.9"),    // tradeLimitRatio
        //     new BN(60 * 60 * 1),      // fundingPeriod
        //     this.priceFeed.address,   // priceFeed 
        //     this.SakePerp.address,         // SakePerp
        //     this.SakePerpVault.address,    // minter
        //     this.priceFeedKey,        // priceFeedKey
        //     this.quoteAsset.address,  // quoteAsset
        //     toFullDigitStr("0.012"),  // fluctuationLimitRatio
        //     toFullDigitStr("0"),      // spreadRatio
        //     toFullDigitStr("1")      // priceAdjustRatio
        // )

        await this.systemSettings.initialize(
            this.SakePerp.address,
            toFullDigitStr("0.5"),
            toFullDigitStr("0.005"),
            toFullDigitStr("0.003"),
            toFullDigitStr("0.5"),
            toFullDigitStr("0.5"),
            86400,
        );
        
        await this.exchange.setOraclePriceSpreadLimit(toDecimal(3))
        await this.SakePerpState.initialize(this.SakePerp.address, 0);
        await this.SakePerpVault.initialize(this.SakePerp.address, this.systemSettings.address, '60');
        await this.SakePerp.initialize(this.systemSettings.address, this.SakePerpVault.address, this.SakePerpState.address);
        await this.insuraceFund.initialize(this.exchange.address, this.SakePerpVault.address);
        await this.systemSettings.addExchange(this.exchange.address, this.insuraceFund.address);
        await this.exchange.setOpen(true)
    });

    // it('dont move AMM price, MM PNL wont change // open long after moving price', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("100000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t3 })

    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"));

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t2 })
    //     const MMPNL1 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     console.log("MMPNL:", MMPNL1.d)
    //     console.log("spotPrice:", (await this.exchange.getSpotPrice()).d)

    //     await this.exchange.moveAMMPriceToOracle(toFullDigitStr("11"), this.priceFeedKey)
    //     const MMPNL2 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     console.log("MMPNL:", MMPNL2.d)
    //     console.log("spotPrice:", (await this.exchange.getSpotPrice()).d)

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t2 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t3 })
    //     const MMPNL3 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     console.log("MMPNL:", MMPNL3.d)
    //     console.log("spotPrice:", (await this.exchange.getSpotPrice()).d)
    //     // assert.equal(MMPNL2.d, MMPNL3.d)
    // })

    // it('dont move AMM price, MM PNL wont change // open short after moving price', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("100000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("100000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t3 })

    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"));

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10"), toDecimal(1), toDecimal(0), { from:t2 })
    //     const MMPNL1 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     console.log("MMPNL:", MMPNL1.d)
    //     console.log("spotPrice:", (await this.exchange.getSpotPrice()).d)

    //     await this.exchange.moveAMMPriceToOracle(toFullDigitStr("11"), this.priceFeedKey)
    //     const MMPNL2 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     console.log("MMPNL:", MMPNL2.d)
    //     console.log("spotPrice:", (await this.exchange.getSpotPrice()).d)

    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("20"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("20"), toDecimal(1), toDecimal(0), { from:t2 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("20"), toDecimal(1), toDecimal(0), { from:t3 })
    //     const MMPNL3 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     console.log("MMPNL:", MMPNL3.d)
    //     console.log("spotPrice:", (await this.exchange.getSpotPrice()).d)
    //     // assert.equal(MMPNL2.d, MMPNL3.d)
    // })

    // it('pay fee to MM when AMM price moved to oracle price', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("100000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("100000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10"))
    //     await this.exchange.setOraclePriceSpreadLimit(toDecimal("10"))

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("1000"), toDecimal(1), toDecimal(0), { from:t1 })
    //     assert.equal(await this.SakePerp.getMMLiquidity(this.exchange.address), toFullDigitStr("10"))

    //     // move AMM price failed
    //     let tx = await this.exchange.moveAMMPriceToOracle(toFullDigit('70'), this.priceFeedKey)
    //     expectEvent(tx, "MoveAMMPrice", {
    //         moved: false
    //     })
    //     assert.equal(await this.SakePerp.getMMLiquidity(this.exchange.address), toFullDigitStr("10"))

    //     // move AMM price (oracle price == AMM price)
    //     await this.exchange.moveAMMPriceToOracle(toFullDigit('40'), this.priceFeedKey)
    //     assert.equal(await this.SakePerp.getMMLiquidity(this.exchange.address), toFullDigitStr("10.5"))

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("1000"), toDecimal(1), toDecimal(0), { from:t1 })
    //     assert.equal(await this.SakePerp.getMMLiquidity(this.exchange.address), toFullDigitStr("10.5"))

    //     // move AMM price success
    //     tx = await this.exchange.moveAMMPriceToOracle(toFullDigit('30'), this.priceFeedKey)
    //     expectEvent(tx, "MoveAMMPrice", {
    //         moved: true
    //     })
    //     assert.equal(await this.SakePerp.getMMLiquidity(this.exchange.address), toFullDigitStr("11"))
    // })

    // it('check delta position size after migrate liqudity', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t4, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t5, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t6, toFullDigit("1000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t3 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t4 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t5 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t6 })
        
    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"));

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t2 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("900"), toDecimal(1), toDecimal(0), { from:t3 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("20"), toDecimal(1), toDecimal(0), { from:t4 })
    //     const t1PositionBefore = await this.SakePerp.getPosition(this.exchange.address, t1)
    //     const t2PositionBefore = await this.SakePerp.getPosition(this.exchange.address, t2)
    //     const t3PositionBefore = await this.SakePerp.getPosition(this.exchange.address, t3)
    //     const t4PositionBefore = await this.SakePerp.getPosition(this.exchange.address, t4)
    //     const t5PositionBefore = await this.SakePerp.getPosition(this.exchange.address, t5)
    //     const t6PositionBefore = await this.SakePerp.getPosition(this.exchange.address, t6)
    //     const positionSizeBefore = await this.exchange.getPositionSize()

    //     const MMPNLBefore = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     // const reserveBefore = await this.exchange.getReserve()

    //     console.log("t1Before: ", t1PositionBefore.size.d)
    //     console.log("t2Before: ", t2PositionBefore.size.d)
    //     console.log("t3Before: ", t3PositionBefore.size.d)
    //     console.log("t4Before: ", t4PositionBefore.size.d)
    //     console.log("t5Before: ", t5PositionBefore.size.d)
    //     console.log("t6Before: ", t6PositionBefore.size.d)
    //     console.log("positionBefore: (long)" + positionSizeBefore[0].d + " (short)" + positionSizeBefore[1].d)
    //     console.log("MMPNLBefore: ", MMPNLBefore.d)
    //     // console.log("reserveBefore: ", reserveBefore[0].d, reserveBefore[1].d)

    //     await this.exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("300"), toDecimal(1), toDecimal(0), { from:t5 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("550"), toDecimal(1), toDecimal(0), { from:t6 })

    //     const MMPNLAfter = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

    //     // await this.exchange.moveAMMPriceToOracle(toFullDigit("11"), this.priceFeedKey)
    //     const MMPNLAfterMovePrice1 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("100"), toDecimal(1), toDecimal(0), { from:t5 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t6 })
    //     const MMPNLAfterMovePrice2 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

    //     // migrate liquidity the second time
    //     // await this.exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
    //     const MMPNLAfterMovePrice3 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

    //     const t1PositionAfter = await this.SakePerp.getPosition(this.exchange.address, t1)
    //     const t2PositionAfter = await this.SakePerp.getPosition(this.exchange.address, t2)
    //     const t3PositionAfter = await this.SakePerp.getPosition(this.exchange.address, t3)
    //     const t4PositionAfter = await this.SakePerp.getPosition(this.exchange.address, t4)
    //     const t5PositionAfter = await this.SakePerp.getPosition(this.exchange.address, t5)
    //     const t6PositionAfter = await this.SakePerp.getPosition(this.exchange.address, t6)
    //     const positionSizeAfter = await this.exchange.getPositionSize()
        
    //     let realLongPositionSizeAfter = new BN(0)
    //     let realShortPositionSizeAfter = new BN(0)
    //     let positionAfterBN = []
    //     positionAfterBN[0] = new BN(t1PositionAfter.size.d)
    //     positionAfterBN[1] = new BN(t2PositionAfter.size.d)
    //     positionAfterBN[2] = new BN(t3PositionAfter.size.d)
    //     positionAfterBN[3] = new BN(t4PositionAfter.size.d)
    //     positionAfterBN[4] = new BN(t5PositionAfter.size.d)
    //     positionAfterBN[5] = new BN(t6PositionAfter.size.d)

    //     for (let i = 0; i < positionAfterBN.length; i++) {
    //         if (positionAfterBN[i].isNeg()) {
    //             realShortPositionSizeAfter = realShortPositionSizeAfter.add(positionAfterBN[i])
    //         } else {
    //             realLongPositionSizeAfter = realLongPositionSizeAfter.add(positionAfterBN[i])
    //         }
    //     }

    //     let tx 
    //     tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t5 })
    //     console.log("t5 exchange size: ", tx.receipt.logs[0].args.exchangedPositionSize.toString())
    //     tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t6 })
    //     console.log("t6 exchange size: ", tx.receipt.logs[0].args.exchangedPositionSize.toString())
    //     tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t1 })
    //     console.log("t1 exchange size: ", tx.receipt.logs[1].args.exchangedPositionSize.toString())
    //     tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t2 })
    //     console.log("t2 exchange size: ", tx.receipt.logs[1].args.exchangedPositionSize.toString())
    //     tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t3 })
    //     console.log("t3 exchange size: ", tx.receipt.logs[1].args.exchangedPositionSize.toString())
    //     tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t4 })
    //     console.log("t4 exchange size: ", tx.receipt.logs[1].args.exchangedPositionSize.toString())
        

    //     // reserveAfter = await this.exchange.getReserve()
    //     // t1Balance = await this.quoteAsset.balanceOf(t1)
    //     // t2Balance = await this.quoteAsset.balanceOf(t2)
    //     // t3Balance = await this.quoteAsset.balanceOf(t3)
    //     // t4Balance = await this.quoteAsset.balanceOf(t4)

    //     // console.log("reserveAfter: ", reserveAfter[0].d, reserveAfter[1].d)
    //     // console.log("t1Balance: ", t1Balance.toString())
    //     // console.log("t2Balance: ", t2Balance.toString())
    //     // console.log("t3Balance: ", t3Balance.toString())
    //     // console.log("t4Balance: ", t4Balance.toString())
    //     // console.log("totalBalance: ", t1Balance.add(t2Balance).add(t3Balance).add(t4Balance).toString())
        
    //     console.log("t1After: ", t1PositionAfter.size.d)
    //     console.log("t2After: ", t2PositionAfter.size.d)
    //     console.log("t3After: ", t3PositionAfter.size.d)
    //     console.log("t4After: ", t4PositionAfter.size.d)
    //     console.log("t5After: ", t5PositionAfter.size.d)
    //     console.log("t6After: ", t6PositionAfter.size.d)
    //     console.log("positionAfter: (long)" + positionSizeAfter[0].d + " (short)" + positionSizeAfter[1].d)
    //     console.log("realPositionAfter: (long)" + realLongPositionSizeAfter.toString() + " (short)" + realShortPositionSizeAfter.toString())
    //     console.log("MMPNLAfter: ", MMPNLAfter.d)
    //     console.log("MMPNLAfterMovePrice1: ", MMPNLAfterMovePrice1.d)
    //     console.log("MMPNLAfterMovePrice2: ", MMPNLAfterMovePrice2.d)
    //     console.log("MMPNLAfterMovePrice3: ", MMPNLAfterMovePrice3.d)
    // })

    // it('check position size', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("1000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t1 })

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t1 })
    //     let t1Position = await this.SakePerp.getPosition(this.exchange.address, t1)
    //     let totalPosition = await this.exchange.getPositionSize()
    //     assert.equal(totalPosition[0].d, t1Position.size.d)
    //     assert.equal(totalPosition[1].d, 0)
        
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("400"), toDecimal(1), toDecimal(0), { from:t1 })
    //     t1Position = await this.SakePerp.getPosition(this.exchange.address, t1)
    //     totalPosition = await this.exchange.getPositionSize()
    //     assert.equal(totalPosition[0].d, 0)
    //     assert.equal(totalPosition[1].d, new BN(t1Position.size.d).abs())
    // })

    // it('attack', async () => {
    //     await this.exchange.setFluctuationLimitRatio(toDecimal("0.022"))
    //     await this.quoteAsset.transfer(t1, toFullDigit("1000000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("1000000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000000"), { from:t2 })

    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"));

    //     for (let i = 0; i < 40; i++) {
    //         await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("10000"), toDecimal(1), toDecimal(0), { from:t1 })
    //     }
    //     console.log((await this.exchange.getSpotPrice()).d)

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("4"), toDecimal(10), toDecimal(0), { from:t2 })
    //     console.log((await this.exchange.getSpotPrice()).d)

    //     for (let i = 0; i < 40; i++) {
    //         await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("10000"), toDecimal(1), toDecimal(0), { from:t1 })
    //     }
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t1 })
    //     console.log((await this.exchange.getSpotPrice()).d)

    //     console.log((await this.quoteAsset.balanceOf(t1)).toString())
    // })

    // it('check MM PNL after migrate liqudity', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t4, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t5, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t6, toFullDigit("1000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t3 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t4 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t5 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t6 })

    //     await this.exchange.setOraclePriceSpreadLimit(toDecimal(3))
    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"));

    //     console.log("deltaOld:", (await this.SakePerpState.snapshotDeltaPosNotional(0)).toString())

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t2 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("200"), toDecimal(1), toDecimal(0), { from:t3 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("300"), toDecimal(1), toDecimal(0), { from:t4 })

    //     const MMPNL1 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     await this.exchange.moveAMMPriceToOracle(toFullDigit('7'), this.priceFeedKey)
    //     const MMPNL2 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     const cumulativeNotional2 = await this.exchange.getCumulativeNotional()
    //     console.log("cumulativeNotional2", cumulativeNotional2.d)

    //     await this.exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("100"), toDecimal(1), toDecimal(0), { from:t5 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t6 })

    //     await this.SakePerp.addMargin(this.exchange.address, toDecimal("10"), { from:t4 })
    //     await this.SakePerp.addMargin(this.exchange.address, toDecimal("10"), { from:t2 })
    //     await this.SakePerp.addMargin(this.exchange.address, toDecimal("10"), { from:t3 })
    //     await this.SakePerp.addMargin(this.exchange.address, toDecimal("10"), { from:t1 })

    //     const t1Position = await this.SakePerp.getPosition(this.exchange.address, t1)
    //     const t2Position = await this.SakePerp.getPosition(this.exchange.address, t2)
    //     const t3Position = await this.SakePerp.getPosition(this.exchange.address, t3)
    //     const t4Position = await this.SakePerp.getPosition(this.exchange.address, t4)
    //     const t5Position = await this.SakePerp.getPosition(this.exchange.address, t5)
    //     const t6Position = await this.SakePerp.getPosition(this.exchange.address, t6)
    //     const t1PositionBN = new BN(t1Position.size.d)
    //     const t2PositionBN = new BN(t2Position.size.d)
    //     const t3PositionBN = new BN(t3Position.size.d)
    //     const t4PositionBN = new BN(t4Position.size.d)
    //     const t5PositionBN = new BN(t5Position.size.d)
    //     const t6PositionBN = new BN(t6Position.size.d)

    //     console.log("t1size:", t1Position.size.d)
    //     // const MMPNL3 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     // const cumulativeNotional3 = await this.exchange.getCumulativeNotional()
    //     // const totalPosition = await this.exchange.totalPositionSize()
    //     // // const positionSize = await this.exchange.getPositionSize()
    //     // console.log("cumulativeNotional3", cumulativeNotional3.d)

    //     // let tx
    //     // tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t6 })
    //     // const t2size = tx.receipt.logs[0].args.exchangedPositionSize
    //     // console.log("deltaOld4:", (await this.SakePerpState.snapshotDeltaPosNotional(0)).toString())
    //     // tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t1 })
    //     // const t1size = tx.receipt.logs[1].args.exchangedPositionSize
    //     // console.log("deltaOld2:", (await this.SakePerpState.snapshotDeltaPosNotional(0)).toString())
    //     // tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t4 })
    //     // const t6size = tx.receipt.logs[1].args.exchangedPositionSize
    //     // tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t2 })
    //     // const t5size = tx.receipt.logs[1].args.exchangedPositionSize
    //     // tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t5 })
    //     // const t3size = tx.receipt.logs[0].args.exchangedPositionSize
    //     // console.log("deltaOld3:", (await this.SakePerpState.snapshotDeltaPosNotional(0)).toString())
    //     // tx = await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t3 })
    //     // const t4size = tx.receipt.logs[1].args.exchangedPositionSize
    //     // console.log("deltaOld1:", (await this.SakePerpState.snapshotDeltaPosNotional(0)).toString())

    //     // const totalPosition2 = await this.exchange.totalPositionSize()
    //     // const MMPNL4 = await this.SakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)
    //     // const cumulativeNotional = await this.exchange.getCumulativeNotional()

    //     // const deltaOld = await this.SakePerpState.snapshotDeltaPosNotional(0)
    //     // const netPosition = t1size.add(t2size).add(t3size).add(t4size).add(t5size).add(t6size)
    //     // // const netPosition = t1size.add(t2size).add(t3size).add(t4size)
    //     // // const netPosition = t1PositionBN.add(t2PositionBN).add(t3PositionBN).add(t4PositionBN).add(t5PositionBN).add(t6PositionBN)
    //     // console.log("netPosition:", netPosition.toString(), totalPosition.toString())
    //     // // console.log("totalPosition2:", totalPosition2.toString())
    //     // // console.log("deltaOld:", deltaOld.toString())

    //     // // const longSize = t1size.add(t4size).add(t6size)
    //     // // const shortSize = t2size.add(t3size).add(t5size)
    //     // // console.log("longPositionSize:", longSize.toString(), positionSize[0].d)
    //     // // console.log("shortPositionSize:", shortSize.toString(), positionSize[1].d)

    //     // const t1Balance = await this.quoteAsset.balanceOf(t1)
    //     // const t2Balance = await this.quoteAsset.balanceOf(t2)
    //     // const t3Balance = await this.quoteAsset.balanceOf(t3)
    //     // const t4Balance = await this.quoteAsset.balanceOf(t4)
    //     // const t5Balance = await this.quoteAsset.balanceOf(t5)
    //     // const t6Balance = await this.quoteAsset.balanceOf(t6)
    //     // const delta = t1Balance.add(t2Balance).add(t3Balance).add(t4Balance).add(t5Balance).add(t6Balance).sub(toFullDigit("6000"))
    //     // console.log("MMPNL1:", MMPNL1.d)
    //     // console.log("MMPNL2:", MMPNL2.d)
    //     // console.log("MMPNL3:", MMPNL3.d)
    //     // console.log("MMPNL4:", MMPNL4.d)
    //     // console.log("cumulativeNotional:", cumulativeNotional.d)
    //     // console.log("delta:", delta.toString())
    // })

    // it('pay funding after migrate liquidity', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t4, toFullDigit("1000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t3 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t4 })
        
    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"))
    //     await this.quoteAsset.transfer(this.insuraceFund.address, toFullDigit("10000"))

    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t2 })

    //     await this.exchange.migrateLiquidity(toDecimal(2), toDecimal(0))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("100"), toDecimal(1), toDecimal(0), { from:t3 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t4 })

    //     await this.priceFeed.setTwapPrice(toFullDigit("20"))
    //     // time = 1444004400
    //     await this.exchange.mock_setBlockTimestamp(1444004410)
    //     await this.SakePerp.payFunding(this.exchange.address)

    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t1 })
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t2 })
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t3 })
    //     await this.SakePerp.closePosition(this.exchange.address, toDecimal(0), { from:t4 })

    //     let b1 = await this.quoteAsset.balanceOf(this.SakePerpVault.address)
    //     console.log("b1:", b1.toString())
    // })

    // it('settle position after migrate liquidity', async () => {
    //     await this.quoteAsset.transfer(t1, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t2, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t3, toFullDigit("1000"))
    //     await this.quoteAsset.transfer(t4, toFullDigit("1000"))
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t1 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t2 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t3 })
    //     await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t4 })
        
    //     await this.quoteAsset.approve(this.SakePerpVault.address, toFullDigit("10000"))
    //     await this.SakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal("10000"))
    //     await this.quoteAsset.transfer(this.insuraceFund.address, toFullDigit("10000"))

    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("500"), toDecimal(1), toDecimal(0), { from:t1 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t2 })

    //     await this.exchange.migrateLiquidity(toDecimal(0.8), toDecimal(0))
    //     await this.SakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("100"), toDecimal(1), toDecimal(0), { from:t3 })
    //     await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:t4 })
    //     await this.exchange.shutdown()

    //     await this.SakePerp.settlePosition(this.exchange.address, { from:t1 })
    //     await this.SakePerp.settlePosition(this.exchange.address, { from:t2 })
    //     await this.SakePerp.settlePosition(this.exchange.address, { from:t3 })
    //     await this.SakePerp.settlePosition(this.exchange.address, { from:t4 })

    //     let b1 = await this.quoteAsset.balanceOf(this.SakePerpVault.address)
    //     console.log("b1:", b1.toString())
    // })

    it('get margin ratio batch', async () => {
        await this.quoteAsset.transfer(t1, toFullDigit("1000"))
        await this.quoteAsset.transfer(t2, toFullDigit("1000"))
        await this.quoteAsset.transfer(t3, toFullDigit("1000"))
        await this.quoteAsset.transfer(t4, toFullDigit("1000"))
        await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t1 })
        await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t2 })
        await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t3 })
        await this.quoteAsset.approve(this.SakePerp.address, toFullDigit("1000"), { from:t4 })

        await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("1"), toDecimal(2), toDecimal(0), { from:t1 })
        await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("1"), toDecimal(4), toDecimal(0), { from:t2 })
        // await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("1"), toDecimal(8), toDecimal(0), { from:t3 })
        await this.SakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("1"), toDecimal(10), toDecimal(0), { from:t4 })

        const ratios = await this.sakePerpViewer.getMarginRatios(this.exchange.address, [t1, t2, t3, t4])
        console.log(ratios[0].d, ratios[1].d, ratios[2].d, ratios[3].d)
    })
})
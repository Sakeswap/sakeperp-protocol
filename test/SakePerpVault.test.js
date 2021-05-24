const { BN, constants, expectEvent, expectRevert, time } = require('@openzeppelin/test-helpers');
const { assert } = require('chai');
const ExchangeFake = artifacts.require('ExchangeFake');
const ExchangeState = artifacts.require('ExchangeState');
const PriceFeedMock = artifacts.require('PriceFeedMock');
const ERC20Token = artifacts.require('ERC20Token');
const InsuranceFund = artifacts.require('InsuranceFund');
const SakePerp = artifacts.require('SakePerp');
const SakePerpVault = artifacts.require('SakePerpVault');
const SakePerpState = artifacts.require('SakePerpState');
const SystemSettings = artifacts.require('SystemSettings');
const MMLPToken = artifacts.require("MMLPToken");
const { toDecimal, toFullDigit, toFullDigitStr, fromDecimal } = require('./helper/number');
const { Side } = require('./helper/contract');

function floatToDecimal(percent) {
    return { d: toFullDigit(percent * 10000).div(new BN(10000)).toString() }
}

function DecimalToFloat(decimal) {
    return new BN(decimal.d).div(new BN(10).pow(new BN(14))).toNumber() / 10000
}

contract("SakePerpVault", ([alice, bob, carol, MM1, MM2, MM3, Trader1, Trader2]) => {
    beforeEach(async () => {
        this.priceFeedKey = "0x0000000000000000000000000000000000000000000000000000000000000001";
        this.priceFeed = await PriceFeedMock.new(toFullDigitStr(10), toFullDigitStr(10));
        this.quoteAsset = await ERC20Token.new("Quote Asset Token", "QAT", toFullDigit(1000000000));
        this.insuranceFund = await InsuranceFund.new();
        this.systemSettings = await SystemSettings.new();
        this.sakePerpState = await SakePerpState.new();
        this.exchangeState = await ExchangeState.new()
        this.sakePerp = await SakePerp.new();
        this.sakePerpVault = await SakePerpVault.new();

        this.exchange = await ExchangeFake.new(
            toFullDigitStr("1000"),   // quoteAssetReserve
            toFullDigitStr("100"),    // baseAssetReserve
            toFullDigitStr("0.9"),    // tradeLimitRatio
            new BN(60 * 60 * 1),      // fundingPeriod
            this.priceFeed.address,   // priceFeed 
            this.sakePerp.address,          // SakePerp
            this.sakePerpVault.address,    // SakePerpVault
            this.priceFeedKey,             // priceFeedKey
            this.quoteAsset.address,       // quoteAsset
            0,                        // fluctuationLimitRatio
            toFullDigitStr("1"),       // priceAdjustRatio
            this.exchangeState.address
        );
        await this.exchange.fakeInitialize()

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
        await this.sakePerpVault.initialize(this.sakePerp.address, this.systemSettings.address, 0);
        await this.sakePerp.initialize(this.systemSettings.address, this.sakePerpVault.address, this.sakePerpState.address);
        await this.sakePerpState.initialize(this.sakePerp.address, 0);
        await this.insuranceFund.initialize(this.exchange.address, this.sakePerpVault.address);

        this.exchangeState.initialize(
            this.exchange.address,
            toFullDigit("0"),
            toFullDigit("0.1"),
            toFullDigit("0.03"),
            toFullDigit("0.01"),
            toFullDigit("200"),
            toFullDigit("0.1"),
            this.systemSettings.address
        )
        
        await this.exchange.setOpen(true);
        await this.exchange.setCounterParty(this.sakePerp.address);
        await this.exchange.setMinter(this.sakePerpVault.address);
        await this.systemSettings.addExchange(this.exchange.address, this.insuranceFund.address);
        await this.sakePerpVault.setRiskLiquidityWeight(this.exchange.address, 800, 0)

        const LPTokenHigh = await this.exchangeState.getLPToken(0)
        const LPTokenLow = await this.exchangeState.getLPToken(1)
        this.LPTokenHigh = await MMLPToken.at(LPTokenHigh)
        this.LPTokenLow = await MMLPToken.at(LPTokenLow)
    });

    it('setSakePerp Works Well', async () => {
        await expectRevert(this.sakePerpVault.setSakePerp(constants.ZERO_ADDRESS, { from: bob }), "caller is not the owner");
        await expectRevert(this.sakePerpVault.setSakePerp(constants.ZERO_ADDRESS, { from: alice }), "empty address");

        await this.sakePerpVault.setSakePerp(bob, { from: alice });
    });

    it('setSystemSettings Works Well', async () => {
        await expectRevert(this.sakePerpVault.setSystemSettings(constants.ZERO_ADDRESS, { from: bob }), "caller is not the owner");
        await expectRevert(this.sakePerpVault.setSystemSettings(constants.ZERO_ADDRESS, { from: alice }), "empty address");

        await this.sakePerpVault.setSystemSettings(bob, { from: alice });
    });

    it('setRiskLiquidityWeight Works Well', async () => {
        assert.equal((await this.sakePerpVault.exchangeInfo(this.exchange.address)).highRiskLiquidityWeight, 800)
        assert.equal((await this.sakePerpVault.exchangeInfo(this.exchange.address)).lowRiskLiquidityWeight, 0)
        await expectRevert(this.sakePerpVault.setRiskLiquidityWeight(this.exchange.address, 700, 100, { from:bob }), "invalid caller")
        await expectRevert(this.sakePerpVault.setRiskLiquidityWeight(this.exchange.address, 0, 0), "invalid weight")
        assert.equal((await this.sakePerpVault.exchangeInfo(this.exchange.address)).highRiskLiquidityWeight, 800)
        assert.equal((await this.sakePerpVault.exchangeInfo(this.exchange.address)).lowRiskLiquidityWeight, 0)
        await this.sakePerpVault.setRiskLiquidityWeight(this.exchange.address, 700, 100)
        assert.equal((await this.sakePerpVault.exchangeInfo(this.exchange.address)).highRiskLiquidityWeight, 700)
        assert.equal((await this.sakePerpVault.exchangeInfo(this.exchange.address)).lowRiskLiquidityWeight, 100)
    })

    it('setMaxLoss Works Well', async () => {
        let maxLoss = await this.sakePerpVault.getMaxLoss(this.exchange.address)
        assert.equal(maxLoss[0], 50)
        assert.equal(maxLoss[1], 25)
        await expectRevert(this.sakePerpVault.setMaxLoss(this.exchange.address, 0, 80, { from:bob }), "invalid caller")
        await expectRevert(this.sakePerpVault.setMaxLoss(this.exchange.address, 0, 120), "invalid max loss value")
        await expectRevert(this.sakePerpVault.setMaxLoss(this.exchange.address, 0, 0), "invalid max loss value")
        await this.sakePerpVault.setMaxLoss(this.exchange.address, 0, 80)
        await this.sakePerpVault.setMaxLoss(this.exchange.address, 1, 10)
        maxLoss = await this.sakePerpVault.getMaxLoss(this.exchange.address)
        assert.equal(maxLoss[0], 80)
        assert.equal(maxLoss[1], 10)
    })

    it('setMaxLoss Works Well / not enough fund', async () => {
        await this.quoteAsset.transfer(Trader1, toFullDigit("1000"))
        await this.quoteAsset.transfer(Trader2, toFullDigit("1000"))
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader1 })
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader2 })

        await this.exchange.setOraclePriceSpreadLimit(toDecimal(3))

        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(40), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(40), { from: MM2 });

        await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:Trader1 })
        await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:Trader2 })
        await this.exchange.moveAMMPriceToOracle(toFullDigit('20'), this.priceFeedKey)
        const MMPNL = await this.sakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

        // totalPNL = -29408987143322797487
        // available liquidity = 40*0.5 + 40*0.25 = 30
        await expectRevert(this.sakePerpVault.setMaxLoss(this.exchange.address, 0, 40), "fund not enough")
        await expectRevert(this.sakePerpVault.setMaxLoss(this.exchange.address, 1, 20), "fund not enough")
        
        await this.sakePerpVault.setMaxLoss(this.exchange.address, 0, 60)
        await this.sakePerpVault.setMaxLoss(this.exchange.address, 1, 30)
        maxLoss = await this.sakePerpVault.getMaxLoss(this.exchange.address)
        assert.equal(maxLoss[0], 60)
        assert.equal(maxLoss[1], 30)
    })

    it('addLiquidity works well', async () => {
        await expectRevert(this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(0)), "input is 0");

        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
        const tx0 = await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));
        const tx1 = await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(20000));
        
        assert.equal((await this.LPTokenHigh.balanceOf(alice)).toString(), toFullDigitStr(10000))
        assert.equal((await this.LPTokenLow.balanceOf(alice)).toString(), toFullDigitStr(20000))
        assert.equal((await this.sakePerpVault.getLockedLiquidity(this.exchange.address, 0, alice)).d, toFullDigitStr(5000))
        assert.equal((await this.sakePerpVault.getLockedLiquidity(this.exchange.address, 1, alice)).d, toFullDigitStr(15000))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(10000))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 1)).d, toFullDigitStr(20000))
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(30000))
        // 10000 * 50% + 20000 * 25%
        assert.equal((await this.sakePerpVault.getTotalMMAvailableLiquidity(this.exchange.address)).d, toFullDigitStr(10000))
        let allLiquidity = await this.sakePerpVault.getAllMMLiquidity(this.exchange.address)
        assert.equal(allLiquidity[0].d, toFullDigitStr(10000))
        assert.equal(allLiquidity[1].d, toFullDigitStr(20000))

        expectEvent(tx0, "LiquidityAdd", {
            exchange: this.exchange.address,
            account: alice,
            risk: "0",
            lpfund: toFullDigitStr(10000),
            tokenamount: toFullDigitStr(10000)
        })

        expectEvent(tx1, "LiquidityAdd", {
            exchange: this.exchange.address,
            account: alice,
            risk: "1",
            lpfund: toFullDigitStr(20000),
            tokenamount: toFullDigitStr(20000)
        })

        await this.quoteAsset.transfer(bob, toFullDigit(20000), { from: alice })
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: bob });
        const tx2 = await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: bob });
        const tx3 = await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10000), { from: bob });

        assert.equal((await this.LPTokenHigh.balanceOf(bob)).toString(), toFullDigitStr(10000))
        assert.equal((await this.LPTokenLow.balanceOf(bob)).toString(), toFullDigitStr(10000))
        assert.equal((await this.sakePerpVault.getLockedLiquidity(this.exchange.address, 0, bob)).d, toFullDigitStr(5000))
        assert.equal((await this.sakePerpVault.getLockedLiquidity(this.exchange.address, 1, bob)).d, toFullDigitStr(7500))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(20000))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 1)).d, toFullDigitStr(30000))
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(50000))
        // 20000 * 50% + 30000 * 25%
        assert.equal((await this.sakePerpVault.getTotalMMAvailableLiquidity(this.exchange.address)).d, toFullDigitStr(17500))
        allLiquidity = await this.sakePerpVault.getAllMMLiquidity(this.exchange.address)
        assert.equal(allLiquidity[0].d, toFullDigitStr(20000))
        assert.equal(allLiquidity[1].d, toFullDigitStr(30000))

        expectEvent(tx2, "LiquidityAdd", {
            exchange: this.exchange.address,
            account: bob,
            risk: "0",
            lpfund: toFullDigitStr(10000),
            tokenamount: toFullDigitStr(10000)
        })

        expectEvent(tx3, "LiquidityAdd", {
            exchange: this.exchange.address,
            account: bob,
            risk: "1",
            lpfund: toFullDigitStr(10000),
            tokenamount: toFullDigitStr(10000)
        })
    })

    it('removeLiquidity works well', async () => {
        await expectRevert(this.sakePerpVault.removeLiquidity(this.exchange.address, 0, toDecimal(0)), "input is 0");

        await this.quoteAsset.transfer(bob, toFullDigit(20000), { from: alice })
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: bob });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(20000), { from: bob });

        await this.quoteAsset.transfer(carol, toFullDigit(10000), { from: alice })
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: carol });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: carol });
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(30000));

        let tx = await this.sakePerpVault.removeLiquidity(this.exchange.address, 0, toDecimal(10000), { from: carol });
        expectEvent(tx, "LiquidityRemove", {
            exchange: this.exchange.address,
            account: carol,
            risk: "0",
            lpfund: toFullDigitStr(9950),
            tokenamount: toFullDigitStr(10000)
        });

        assert.equal((await this.sakePerpVault.getLockedLiquidity(this.exchange.address, 0, carol)).d, "0")
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(20050))
        assert.equal((await this.sakePerpVault.getTotalMMAvailableLiquidity(this.exchange.address)).d, toFullDigitStr(10050))

        assert.equal((await this.LPTokenHigh.balanceOf(carol)).toString(), "0");
        await this.sakePerpVault.removeLiquidity(this.exchange.address, 0, toDecimal(10000), { from: bob });
        assert.equal((await this.LPTokenHigh.balanceOf(bob)).toString(), toFullDigitStr(10000));
        
        assert.equal((await this.sakePerpVault.getLockedLiquidity(this.exchange.address, 0, bob)).d, toFullDigitStr(5000))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, "10075125000000000000000")
        assert.equal((await this.sakePerpVault.getTotalMMAvailableLiquidity(this.exchange.address)).d, "5075125000000000000000")

        assert.equal((await this.quoteAsset.balanceOf(carol)) < (await this.quoteAsset.balanceOf(bob)), true);
    });

    it('withdraw works well', async () => {
        await expectRevert(this.sakePerpVault.withdraw(this.exchange.address,carol, toDecimal(10000)), "only sakePerp");
        await this.sakePerpVault.setSakePerp(alice);

        this.quoteAsset.transfer(this.sakePerpVault.address, toFullDigit(10000));
        await expectRevert(this.sakePerpVault.withdraw(this.exchange.address, carol, toDecimal(20000)), "Fund not enough");

        this.quoteAsset.transfer(this.sakePerpVault.address, toFullDigit(10000));
        await this.sakePerpVault.withdraw(this.exchange.address, carol, toDecimal(10000));
        assert.equal((await this.quoteAsset.balanceOf(carol)), toFullDigitStr(10000));
    });

    it('ModifyLiquidity works well', async () => {
        await expectRevert(this.sakePerpVault.addCachedLiquidity(this.exchange.address, toDecimal(10000)), "only sakePerp");
        await this.sakePerpVault.setSakePerp(alice);
        await this.sakePerpVault.addCachedLiquidity(this.exchange.address, toDecimal(9000))

        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000));
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10000));
        await this.exchange.fakeModifyLiquidity();

        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(19000))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 1)).d, toFullDigitStr(10000))
        assert.equal((await this.sakePerpVault.getTotalMMCachedLiquidity(this.exchange.address)).d, "0")
    });

    it('realizeBadDebt works well', async () => {
        await expectRevert(this.sakePerpVault.realizeBadDebt(this.exchange.address, toDecimal(10000)), "only sakePerp");

        await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigit(10000));
        await this.sakePerpVault.setSakePerp(alice);
        assert.equal((await this.quoteAsset.balanceOf(this.insuranceFund.address)), toFullDigitStr(10000));
        assert.equal((await this.quoteAsset.balanceOf(this.sakePerpVault.address)), toFullDigitStr(0));
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).toString() == toFullDigitStr(0), true)
        await expectRevert(this.sakePerpVault.realizeBadDebt(this.exchange.address, toDecimal(20000)), "MM Bankrupt");

        await this.sakePerpVault.realizeBadDebt(this.exchange.address, toDecimal(10000));
        assert.equal((await this.quoteAsset.balanceOf(this.sakePerpVault.address)), toFullDigitStr(10000));
        assert.equal((await this.quoteAsset.balanceOf(this.insuranceFund.address)), toFullDigitStr(0))

        await this.quoteAsset.transfer(this.insuranceFund.address, toFullDigit(10000));
        await this.quoteAsset.transfer(MM1, toFullDigit(10000), { from: alice })
        await this.quoteAsset.transfer(MM2, toFullDigit(10000), { from: alice })
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10000), { from: MM2 });

        const tx = await this.sakePerpVault.realizeBadDebt(this.exchange.address, toDecimal(10900));
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(19100))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(9100))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 1)).d, toFullDigitStr(10000))

        expectEvent(tx, "BadDebtResolved", {
            exchange: this.exchange.address,
            badDebt: toFullDigitStr(10900),
            insuranceFundResolveBadDebt: toFullDigitStr(10000),
            mmHighResolveBadDebt: toFullDigitStr(900),
            mmLowResolveBadDebt: toFullDigitStr(0)
        });
    });

    it('realizeBadDebt works well / high risk pool fund not enough', async () => {
        await this.sakePerpVault.setSakePerp(alice);

        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(100), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10000), { from: MM2 });

        const tx = await this.sakePerpVault.realizeBadDebt(this.exchange.address, toDecimal(900));
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(9200))
        // highFactor = 800  lowFactor = 0
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(50))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 1)).d, toFullDigitStr(9150))

        expectEvent(tx, "BadDebtResolved", {
            exchange: this.exchange.address,
            badDebt: toFullDigitStr(900),
            insuranceFundResolveBadDebt: toFullDigitStr(0),
            mmHighResolveBadDebt: toFullDigitStr(50),
            mmLowResolveBadDebt: toFullDigitStr(850)
        });
    })

    it('realizeBadDebt works well / low risk pool fund not enough', async () => {
        await this.sakePerpVault.setSakePerp(alice);

        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10000), { from: MM2 });

        await this.sakePerpVault.setRiskLiquidityWeight(this.exchange.address, 0, 100)
        const tx = await this.sakePerpVault.realizeBadDebt(this.exchange.address, toDecimal(6000));
        // highFactor = 0  lowFactor = 100
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(14000))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 0)).d, toFullDigitStr(6500))
        assert.equal((await this.sakePerpVault.getMMLiquidity(this.exchange.address, 1)).d, toFullDigitStr(7500))

        expectEvent(tx, "BadDebtResolved", {
            exchange: this.exchange.address,
            badDebt: toFullDigitStr(6000),
            insuranceFundResolveBadDebt: toFullDigitStr(0),
            mmHighResolveBadDebt: toFullDigitStr(3500),
            mmLowResolveBadDebt: toFullDigitStr(2500)
        });
    })

    it("removeLiquidityWhenShutdown Traders Works well", async () => {
        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.transfer(Trader1, toFullDigit(1015))
        await this.quoteAsset.transfer(Trader2, toFullDigit(1015))

        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: MM1 });

        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: MM2 });

        //total 
        await this.exchange.shutdown();

        await this.sakePerpVault.removeLiquidityWhenShutdown(this.exchange.address, 0, { from: MM1 });
        await this.sakePerpVault.removeLiquidityWhenShutdown(this.exchange.address, 0, { from: MM2 });

        assert.equal((await this.quoteAsset.balanceOf(MM1)).toString(), toFullDigitStr('10000'));
        assert.equal((await this.quoteAsset.balanceOf(MM2)).toString(), toFullDigitStr('10000'));
    });
    
    it('getLpTokenPrice works well', async () => {
        let lpTokenPriceHigh = await this.sakePerpVault.getLpTokenPrice(this.exchange.address, 0)
        assert.equal(lpTokenPriceHigh.tokenPriceWithFee, "1000000000000000000")
        assert.equal(lpTokenPriceHigh.tokenPrice, "1000000000000000000")
        let lpTokenPriceLow = await this.sakePerpVault.getLpTokenPrice(this.exchange.address, 0)
        assert.equal(lpTokenPriceLow.tokenPriceWithFee, "1000000000000000000")
        assert.equal(lpTokenPriceLow.tokenPrice, "1000000000000000000")

        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000));
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000));
        assert.equal((await this.LPTokenHigh.balanceOf(alice)).toString(), toFullDigitStr(10000))
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(10000))

        await this.quoteAsset.transfer(bob, toFullDigit(20000), { from: alice })
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(100000000), { from: bob });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(20000), { from: bob });
        assert.equal((await this.sakePerpVault.getTotalMMLiquidity(this.exchange.address)).d, toFullDigitStr(30000));
        assert.equal((await this.LPTokenHigh.balanceOf(alice)).mul(new BN(2)).toString(), (await this.LPTokenHigh.balanceOf(bob)).toString());

        lpTokenPriceHigh = await this.sakePerpVault.getLpTokenPrice(this.exchange.address, 0)
        assert.equal(lpTokenPriceHigh.tokenPriceWithFee, "1000000000000000000")
        assert.equal(lpTokenPriceHigh.tokenPrice, "1000000000000000000")
    });

    it('getAllLpUnrealizedPNL works well', async () => {
        await this.quoteAsset.transfer(Trader1, toFullDigit("1000"))
        await this.quoteAsset.transfer(Trader2, toFullDigit("1000"))
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader1 })
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader2 })

        await this.exchange.setOraclePriceSpreadLimit(toDecimal(3))

        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(10000), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10000), { from: MM2 });

        await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:Trader1 })
        await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:Trader2 })
        await this.exchange.moveAMMPriceToOracle(toFullDigit('7'), this.priceFeedKey)
        const MMPNL = await this.sakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

        // totalPNL = 200867192903582541094
        // highFactor = 800   lowFactor = 0
        const pnl = await this.sakePerpVault.getAllLpUnrealizedPNL(this.exchange.address)
        assert.equal(pnl[0].d, "200866250000000000000")
        assert.equal(pnl[1].d, "942903582541094")
    })

    it('getAllLpUnrealizedPNL works well / high risk fund not enough', async () => {
        await this.quoteAsset.transfer(Trader1, toFullDigit("1000"))
        await this.quoteAsset.transfer(Trader2, toFullDigit("1000"))
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader1 })
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader2 })

        await this.exchange.setOraclePriceSpreadLimit(toDecimal(3))

        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(50), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(50), { from: MM2 });

        await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:Trader1 })
        await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:Trader2 })
        await this.exchange.moveAMMPriceToOracle(toFullDigit('20'), this.priceFeedKey)
        const MMPNL = await this.sakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

        // totalPNL = -29408987143322797487
        // highFactor = 800   lowFactor = 0
        const pnl = await this.sakePerpVault.getAllLpUnrealizedPNL(this.exchange.address)
        assert.equal(pnl[0].d, "-" + toFullDigitStr('25'))
        assert.equal(pnl[1].d, "-4408987143322797487")
    })

    it('getAllLpUnrealizedPNL works well / when total liquidity is negtive', async () => {
        await this.quoteAsset.transfer(Trader1, toFullDigit("1000"))
        await this.quoteAsset.transfer(Trader2, toFullDigit("1000"))
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader1 })
        await this.quoteAsset.approve(this.sakePerp.address, toFullDigit("1000"), { from:Trader2 })

        await this.exchange.setOraclePriceSpreadLimit(toDecimal(3))

        await this.quoteAsset.transfer(MM1, toFullDigit(10000))
        await this.quoteAsset.transfer(MM2, toFullDigit(10000))
        await this.quoteAsset.transfer(MM3, toFullDigit(10000))
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM1 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(9), { from: MM1 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM2 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(1), { from: MM2 });
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit(10000000), { from: MM3 });
        await this.sakePerpVault.addLiquidity(this.exchange.address, 1, toDecimal(10), { from: MM3 });

        await this.sakePerp.openPosition(this.exchange.address, Side.BUY, toDecimal("500"), toDecimal(1), toDecimal(0), { from:Trader1 })
        await this.sakePerp.openPosition(this.exchange.address, Side.SELL, toDecimal("150"), toDecimal(1), toDecimal(0), { from:Trader2 })
        await this.exchange.moveAMMPriceToOracle(toFullDigit('7'), this.priceFeedKey)
        const MMPNL = await this.sakePerpVault.getTotalLpUnrealizedPNL(this.exchange.address)

        // totalPNL = 200867192903582541094
        const MM1TokenAmount = (await this.LPTokenHigh.balanceOf(MM1)).toString()
        await this.sakePerpVault.removeLiquidity(this.exchange.address, 0, toDecimal(MM1TokenAmount, 0), { from: MM1 })
        const liquidity = await this.sakePerpVault.getAllMMLiquidity(this.exchange.address)
        console.log(liquidity[0].d, liquidity[1].d)
        const pnl = await this.sakePerpVault.getAllLpUnrealizedPNL(this.exchange.address)
        console.log(pnl[0].d, pnl[1].d)
        // assert.equal(pnl[0].d, "-" + toFullDigitStr('25'))
        // assert.equal(pnl[1].d, "-4408987143322797487")
    })

    it('lock liquidity works well', async () => {
        assert.equal((await this.sakePerpVault.lpLockTime()).toString(), 0)
        await this.sakePerpVault.setLpLockTime(86400)
        assert.equal((await this.sakePerpVault.lpLockTime()).toString(), 86400)

        let curTime = await time.latest()
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit("10000000"))
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(1000));
        let nextWithdrawTime = await this.sakePerpVault.getNextWidhdrawTime(this.exchange.address, 0, alice)
        assert.equal(nextWithdrawTime.gte(curTime.add(new BN(86400))), true)
        await expectRevert(this.sakePerpVault.removeLiquidity(this.exchange.address, 0, toDecimal(1)), "liquidity locked")
        
        curTime = await time.latest()
        await time.increase(new BN(86400))
        await this.sakePerpVault.removeLiquidity(this.exchange.address, 0, toDecimal(1))
        nextWithdrawTime = await this.sakePerpVault.getNextWidhdrawTime(this.exchange.address, 0, alice)
        assert.equal(nextWithdrawTime.gte(curTime.add(new BN(86400))), true)

        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(1));
        assert.equal(await this.sakePerpVault.getNextWidhdrawTime(this.exchange.address, 0, alice), nextWithdrawTime.toString())

        await time.increase(new BN(86400))
        let totalLpAmount = await this.LPTokenHigh.balanceOf(alice)
        await this.sakePerpVault.removeLiquidity(this.exchange.address, 0, {d: totalLpAmount.toString()})
        await time.increase(new BN(86400))
        curTime = await time.latest()
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(1));
        nextWithdrawTime = await this.sakePerpVault.getNextWidhdrawTime(this.exchange.address, 0, alice)
        assert.equal(nextWithdrawTime.gte(curTime.add(new BN(86400))), true)
    })

    it('block lp token transfer work well', async () => {
        await this.quoteAsset.approve(this.sakePerpVault.address, toFullDigit("10000000"))
        await this.sakePerpVault.addLiquidity(this.exchange.address, 0, toDecimal(1000))

        await expectRevert(this.LPTokenHigh.transfer(bob, "100"), "illegal transfer")
        await this.systemSettings.setBlockTransfer(false)
        await this.LPTokenHigh.transfer(bob, "100")
        assert.equal(await this.LPTokenHigh.balanceOf(bob), "100")

        await this.systemSettings.setBlockTransfer(true)
        await this.systemSettings.setTransferWhitelist(alice, true)
        await this.LPTokenHigh.transfer(bob, "100")
        assert.equal(await this.LPTokenHigh.balanceOf(bob), "200")
        await this.systemSettings.setTransferWhitelist(alice, false)
        await expectRevert(this.LPTokenHigh.transfer(bob, "100"), "illegal transfer")
    })
})
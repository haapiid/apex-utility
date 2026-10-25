const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');

const E = (n) => ethers.parseEther(String(n));
const DEAD = '0x000000000000000000000000000000000000dEaD';
const PARAMS = { virtualEth: E('1.5'), virtualTokens: E('1073000000'), curveTokens: E('793100000') };
const SUPPLY = E('1000000000');

async function deadline() {
  return (await time.latest()) + 600;
}

async function fixture() {
  const [owner, treasury, creator, alice, bob] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory('WETH9')).deploy();
  const factory = await (await ethers.getContractFactory('UniswapV2Factory')).deploy(owner.address);
  const pad = await (await ethers.getContractFactory('ApeLaunchpad')).deploy(
    owner.address,
    treasury.address,
    await factory.getAddress(),
    await weth.getAddress(),
    PARAMS,
  );
  return { owner, treasury, creator, alice, bob, weth, factory, pad };
}

async function withToken(devBuy = 0n) {
  const f = await loadFixture(fixture);
  const tx = await f.pad.connect(f.creator).createToken('Ape Coin', 'APE', 'ipfs://meta', 0, await deadline(), { value: devBuy });
  const receipt = await tx.wait();
  const ev = receipt.logs.map((l) => f.pad.interface.parseLog(l)).find((l) => l?.name === 'TokenCreated');
  const token = await ethers.getContractAt('LaunchToken', ev.args.token);
  const pair = await ethers.getContractAt('@uniswap/v2-core/contracts/UniswapV2Pair.sol:UniswapV2Pair', ev.args.pair);
  return { ...f, token, pair, addr: ev.args.token };
}

// Every wei the launchpad holds must belong to a live curve or an unclaimed fee
async function expectSolvent({ pad, treasury, creator, addr }) {
  const c = await pad.curves(addr);
  const owed = (await pad.feesOwed(treasury.address)) + (await pad.feesOwed(creator.address));
  expect(await ethers.provider.getBalance(await pad.getAddress())).to.equal(c.realEth + owed);
}

describe('ApeLaunchpad', () => {
  describe('create', () => {
    it('mints the supply to the launchpad, creates the pair and opens a curve', async () => {
      const { pad, token, pair, factory, weth, creator, addr } = await withToken();
      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.balanceOf(await pad.getAddress())).to.equal(SUPPLY);
      expect(await factory.getPair(addr, await weth.getAddress())).to.equal(await pair.getAddress());
      expect(await token.metadataURI()).to.equal('ipfs://meta');
      const c = await pad.curves(addr);
      expect(c.creator).to.equal(creator.address);
      expect(c.tokensLeft).to.equal(PARAMS.curveTokens);
      expect(c.poolTokens).to.equal(SUPPLY - PARAMS.curveTokens);
      expect(await pad.tokenCount()).to.equal(1);
      expect(await pad.progressBps(addr)).to.equal(0);
    });

    it('runs the dev buy in the same transaction', async () => {
      const { token, creator } = await withToken(E('0.1'));
      expect(await token.balanceOf(creator.address)).to.be.gt(0);
    });

    it('rejects bad names, short payment and expired deadlines', async () => {
      const { pad, owner } = await loadFixture(fixture);
      const d = await deadline();
      await expect(pad.createToken('', 'A', '', 0, d)).to.be.revertedWithCustomError(pad, 'BadName');
      await expect(pad.createToken('A', 'TOOLONGSYMBOL', '', 0, d)).to.be.revertedWithCustomError(pad, 'BadName');
      await expect(pad.createToken('A'.repeat(33), 'A', '', 0, d)).to.be.revertedWithCustomError(pad, 'BadName');
      await expect(pad.createToken('A', 'A', '', 0, (await time.latest()) - 1)).to.be.revertedWithCustomError(pad, 'Expired');
      await pad.connect(owner).setFees(100, 0, 200, E('0.01'));
      await expect(pad.createToken('A', 'A', '', 0, d, { value: E('0.005') })).to.be.revertedWithCustomError(pad, 'InsufficientPayment');
      await pad.createToken('A', 'A', '', 0, d, { value: E('0.01') });
    });
  });

  describe('trade', () => {
    it('buys at the quoted amount and charges 1% to the treasury', async () => {
      const f = await withToken();
      const { pad, token, alice, treasury, addr } = f;
      const [quoted, fee, refund] = await pad.quoteBuy(addr, E(1));
      expect(fee).to.equal(E('0.01'));
      expect(refund).to.equal(0);
      await pad.connect(alice).buy(addr, quoted, await deadline(), { value: E(1) });
      expect(await token.balanceOf(alice.address)).to.equal(quoted);
      expect(await pad.feesOwed(treasury.address)).to.equal(E('0.01'));
      await expectSolvent(f);
    });

    it('raises the price as tokens are bought', async () => {
      const { pad, alice, addr } = await withToken();
      const p0 = await pad.price(addr);
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) });
      expect(await pad.price(addr)).to.be.gt(p0);
    });

    it('reverts on slippage, zero value and expired deadline', async () => {
      const { pad, alice, addr } = await withToken();
      const [quoted] = await pad.quoteBuy(addr, E(1));
      await expect(pad.connect(alice).buy(addr, quoted + 1n, await deadline(), { value: E(1) })).to.be.revertedWithCustomError(pad, 'Slippage');
      await expect(pad.connect(alice).buy(addr, 0, await deadline())).to.be.revertedWithCustomError(pad, 'ZeroAmount');
      await expect(pad.connect(alice).buy(addr, 0, (await time.latest()) - 1, { value: E(1) })).to.be.revertedWithCustomError(pad, 'Expired');
      await expect(pad.connect(alice).buy(alice.address, 0, await deadline(), { value: E(1) })).to.be.revertedWithCustomError(pad, 'UnknownToken');
    });

    it('sells back for the quoted ETH; a round trip only loses the fees', async () => {
      const f = await withToken();
      const { pad, token, alice, addr } = f;
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) });
      const bal = await token.balanceOf(alice.address);
      await token.connect(alice).approve(await pad.getAddress(), bal);
      const [ethOut, fee] = await pad.quoteSell(addr, bal);
      const before = await ethers.provider.getBalance(alice.address);
      const receipt = await (await pad.connect(alice).sell(addr, bal, ethOut, await deadline())).wait();
      const gas = receipt.gasUsed * receipt.gasPrice;
      expect((await ethers.provider.getBalance(alice.address)) - before + gas).to.equal(ethOut);
      // paid 1 ETH: 0.99 went into the curve, about 0.0099 is the sell fee
      expect(ethOut + fee).to.be.closeTo(E('0.99'), 2n);
      expect((await pad.curves(addr)).tokensLeft).to.equal(PARAMS.curveTokens);
      await expectSolvent(f);
    });

    it('never pays out more than the curve holds across many trades', async () => {
      const f = await withToken();
      const { pad, token, alice, bob, addr } = f;
      const padAddr = await pad.getAddress();
      await token.connect(alice).approve(padAddr, ethers.MaxUint256);
      await token.connect(bob).approve(padAddr, ethers.MaxUint256);
      for (let i = 0; i < 8; i++) {
        await pad.connect(alice).buy(addr, 0, await deadline(), { value: E('0.137') * BigInt(i + 1) });
        await pad.connect(bob).buy(addr, 0, await deadline(), { value: E('0.071') });
        await pad.connect(alice).sell(addr, (await token.balanceOf(alice.address)) / 3n, 0, await deadline());
      }
      await pad.connect(alice).sell(addr, await token.balanceOf(alice.address), 0, await deadline());
      await pad.connect(bob).sell(addr, await token.balanceOf(bob.address), 0, await deadline());
      const c = await pad.curves(addr);
      expect(c.tokensLeft).to.equal(PARAMS.curveTokens);
      expect(c.virtualEth).to.be.gte(PARAMS.virtualEth);
      await expectSolvent(f);
    });

    it('pays the creator fee when it is turned on', async () => {
      const { pad, owner, creator, alice, addr } = await withToken();
      await pad.connect(owner).setFees(100, 50, 200, 0);
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) });
      expect(await pad.feesOwed(creator.address)).to.equal(E('0.005'));
      const before = await ethers.provider.getBalance(creator.address);
      const r = await (await pad.connect(creator).claimFees()).wait();
      expect((await ethers.provider.getBalance(creator.address)) - before + r.gasUsed * r.gasPrice).to.equal(E('0.005'));
      await expect(pad.connect(creator).claimFees()).to.be.revertedWithCustomError(pad, 'ZeroAmount');
    });
  });

  describe('graduation', () => {
    it('blocks transfers to the pair before graduation', async () => {
      const { pad, token, pair, alice, addr } = await withToken();
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) });
      await expect(token.connect(alice).transfer(await pair.getAddress(), 1)).to.be.revertedWithCustomError(token, 'PoolNotOpen');
      await expect(token.openTrading()).to.be.revertedWithCustomError(token, 'NotLaunchpad');
    });

    it('sells out, refunds the rest, seeds Uniswap at the curve price and burns the LP', async () => {
      const f = await withToken();
      const { pad, token, pair, weth, alice, treasury, addr } = f;
      const [quoted, , refund] = await pad.quoteBuy(addr, E(10));
      expect(quoted).to.equal(PARAMS.curveTokens);
      expect(refund).to.be.gt(0);

      const before = await ethers.provider.getBalance(alice.address);
      const r = await (await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(10) })).wait();
      const spent = before - (await ethers.provider.getBalance(alice.address)) - r.gasUsed * r.gasPrice;
      expect(spent).to.equal(E(10) - refund);

      const c = await pad.curves(addr);
      expect(c.graduated).to.equal(true);
      expect(c.realEth).to.equal(0);
      expect(await token.tradingOpen()).to.equal(true);
      expect(await pad.progressBps(addr)).to.equal(10_000);

      // Pool price equals the curve's last price
      const [r0, r1] = await pair.getReserves();
      const tokenIs0 = (await pair.token0()) === addr;
      const [rt, re] = tokenIs0 ? [r0, r1] : [r1, r0];
      const poolPrice = (re * E(1)) / rt;
      const curvePrice = (c.virtualEth * E(1)) / c.virtualTokens;
      expect(poolPrice).to.be.closeTo(curvePrice, curvePrice / 1_000_000n);
      // About 4.25 ETH raised, 2% graduation fee
      expect(re).to.be.closeTo(E('4.165'), E('0.01'));

      // LP tokens burned, nothing left on the launchpad, unused reserve burned
      const lp = await pair.balanceOf(DEAD);
      expect(lp).to.be.gt(0);
      expect(await pair.totalSupply()).to.equal(lp + 1000n);
      expect(await token.balanceOf(await pad.getAddress())).to.equal(0);
      expect(await token.totalSupply()).to.equal(PARAMS.curveTokens + rt);
      expect(await weth.balanceOf(await pad.getAddress())).to.equal(0);
      expect(await ethers.provider.getBalance(await pad.getAddress())).to.equal(await pad.feesOwed(treasury.address));

      await expect(pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) })).to.be.revertedWithCustomError(pad, 'AlreadyGraduated');
      await expect(pad.connect(alice).sell(addr, 1, 0, await deadline())).to.be.revertedWithCustomError(pad, 'AlreadyGraduated');
    });

    it('trades on Uniswap after graduation', async () => {
      const { pad, token, pair, weth, alice, bob, addr } = await withToken();
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(10) });
      // Swap 1M tokens for WETH directly on the pair (what a router does)
      const amountIn = E(1_000_000);
      const [r0, r1] = await pair.getReserves();
      const tokenIs0 = (await pair.token0()) === addr;
      const [rIn, rOut] = tokenIs0 ? [r0, r1] : [r1, r0];
      const out = (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);
      await token.connect(alice).transfer(await pair.getAddress(), amountIn);
      await pair.connect(alice).swap(tokenIs0 ? 0 : out, tokenIs0 ? out : 0, bob.address, '0x');
      expect(await weth.balanceOf(bob.address)).to.equal(out);
    });

    it('still graduates when someone pre-funds the pair with WETH', async () => {
      const { pad, pair, weth, bob, alice, addr } = await withToken();
      await weth.connect(bob).deposit({ value: E(1) });
      await weth.connect(bob).transfer(await pair.getAddress(), E(1));
      await pair.sync();
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(10) });
      expect((await pad.curves(addr)).graduated).to.equal(true);
      expect(await pair.balanceOf(DEAD)).to.be.gt(0);
    });
  });

  describe('admin', () => {
    it('pause stops create and buy but never sell', async () => {
      const { pad, token, owner, alice, addr } = await withToken();
      await pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) });
      await pad.connect(owner).setPaused(true);
      await expect(pad.connect(alice).buy(addr, 0, await deadline(), { value: E(1) })).to.be.revertedWithCustomError(pad, 'Paused');
      await expect(pad.createToken('B', 'B', '', 0, await deadline())).to.be.revertedWithCustomError(pad, 'Paused');
      const bal = await token.balanceOf(alice.address);
      await token.connect(alice).approve(await pad.getAddress(), bal);
      await pad.connect(alice).sell(addr, bal, 0, await deadline());
    });

    it('enforces fee caps and owner-only setters', async () => {
      const { pad, owner, alice } = await loadFixture(fixture);
      await expect(pad.connect(owner).setFees(201, 0, 0, 0)).to.be.revertedWithCustomError(pad, 'FeeTooHigh');
      await expect(pad.connect(owner).setFees(0, 101, 0, 0)).to.be.revertedWithCustomError(pad, 'FeeTooHigh');
      await expect(pad.connect(owner).setFees(0, 0, 1001, 0)).to.be.revertedWithCustomError(pad, 'FeeTooHigh');
      await expect(pad.connect(owner).setFees(0, 0, 0, E('0.11'))).to.be.revertedWithCustomError(pad, 'FeeTooHigh');
      await expect(pad.connect(alice).setFees(0, 0, 0, 0)).to.be.revertedWithCustomError(pad, 'OwnableUnauthorizedAccount');
      await expect(pad.connect(alice).setPaused(true)).to.be.revertedWithCustomError(pad, 'OwnableUnauthorizedAccount');
      await expect(pad.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(pad, 'OwnableUnauthorizedAccount');
      await expect(pad.connect(owner).setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(pad, 'ZeroAddress');
    });

    it('rejects a curve whose reserve cannot cover the pool', async () => {
      const { pad, owner } = await loadFixture(fixture);
      // 800M on the curve leaves 200M, but the pool needs about 203.5M
      await expect(pad.connect(owner).setLaunchParams({ ...PARAMS, curveTokens: E('800000000') })).to.be.revertedWithCustomError(
        pad,
        'InvalidParams',
      );
      await expect(pad.connect(owner).setLaunchParams({ ...PARAMS, virtualTokens: PARAMS.curveTokens })).to.be.revertedWithCustomError(
        pad,
        'InvalidParams',
      );
      await pad.connect(owner).setLaunchParams({ ...PARAMS, virtualEth: E(3) });
    });

    it('new launch params only affect new tokens', async () => {
      const { pad, owner, addr } = await withToken();
      await pad.connect(owner).setLaunchParams({ ...PARAMS, virtualEth: E(3) });
      expect((await pad.curves(addr)).virtualEth).to.equal(PARAMS.virtualEth);
    });
  });
});

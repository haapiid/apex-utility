// Deploys ApeLaunchpad. Mainnet uses Robinhood's Uniswap V2; on the testnet (or any chain without
// LAUNCHPAD_V2_FACTORY / LAUNCHPAD_WETH) it deploys its own Uniswap V2 factory + WETH first.
// Writes the addresses to deployments/<network>.json.
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');

// Verified on-chain 2026-10-25: router 0x89e5…eba points at this factory and this WETH
const DEFAULTS = {
  hood: {
    factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
    weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  },
};

const PARAMS = {
  virtualEth: ethers.parseEther(process.env.LAUNCHPAD_VIRTUAL_ETH || '1.5'),
  virtualTokens: ethers.parseEther(process.env.LAUNCHPAD_VIRTUAL_TOKENS || '1073000000'),
  curveTokens: ethers.parseEther(process.env.LAUNCHPAD_CURVE_TOKENS || '793100000'),
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error('Set DEPLOYER_PRIVATE_KEY in contracts/launchpad/.env');
  const treasury = process.env.EVM_TREASURY_ADDRESS;
  if (!treasury || !ethers.isAddress(treasury)) throw new Error('Set EVM_TREASURY_ADDRESS (receives the fees)');
  const owner = process.env.LAUNCHPAD_OWNER || deployer.address;

  console.log(`Network ${network.name} (chain ${network.config.chainId}), deployer ${deployer.address}`);
  console.log(`Balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  let factory = process.env.LAUNCHPAD_V2_FACTORY || DEFAULTS[network.name]?.factory;
  let weth = process.env.LAUNCHPAD_WETH || DEFAULTS[network.name]?.weth;
  if (!factory || !weth) {
    if (network.name === 'hood') throw new Error('Mainnet must use the existing Uniswap V2');
    console.log('No Uniswap V2 configured: deploying a factory and WETH for this network');
    const w = await (await ethers.getContractFactory('WETH9')).deploy();
    await w.waitForDeployment();
    const f = await (await ethers.getContractFactory('UniswapV2Factory')).deploy(owner);
    await f.waitForDeployment();
    weth = await w.getAddress();
    factory = await f.getAddress();
  }

  const pad = await (await ethers.getContractFactory('ApeLaunchpad')).deploy(
    owner,
    treasury,
    ethers.getAddress(factory),
    ethers.getAddress(weth),
    PARAMS,
  );
  await pad.waitForDeployment();
  const address = await pad.getAddress();

  // Optional fee overrides (contract defaults: 1% trade, 0% creator, 2% graduation, no create fee)
  if (process.env.LAUNCHPAD_TRADE_FEE_BPS || process.env.LAUNCHPAD_CREATOR_FEE_BPS || process.env.LAUNCHPAD_CREATE_FEE) {
    if (owner !== deployer.address) {
      console.log('Fee overrides skipped: LAUNCHPAD_OWNER is not the deployer, set them from the owner wallet');
    } else {
      await (
        await pad.setFees(
          Number(process.env.LAUNCHPAD_TRADE_FEE_BPS || 100),
          Number(process.env.LAUNCHPAD_CREATOR_FEE_BPS || 0),
          Number(process.env.LAUNCHPAD_GRADUATION_FEE_BPS || 200),
          ethers.parseEther(process.env.LAUNCHPAD_CREATE_FEE || '0'),
        )
      ).wait();
    }
  }

  const out = {
    network: network.name,
    chainId: network.config.chainId,
    launchpad: address,
    owner,
    treasury,
    v2Factory: ethers.getAddress(factory),
    weth: ethers.getAddress(weth),
    params: Object.fromEntries(Object.entries(PARAMS).map(([k, v]) => [k, v.toString()])),
    block: (await pad.deploymentTransaction().wait()).blockNumber,
    deployedAt: new Date().toISOString(),
  };
  const dir = path.join(__dirname, '..', 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), `${JSON.stringify(out, null, 2)}\n`);
  const args = [owner, treasury, out.v2Factory, out.weth, Object.values(out.params)];
  fs.writeFileSync(path.join(dir, `${network.name}.args.js`), `module.exports = ${JSON.stringify(args, null, 2)};\n`);
  console.log(out);
  console.log(`Verify: npx hardhat verify --network ${network.name} --constructor-args deployments/${network.name}.args.js ${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

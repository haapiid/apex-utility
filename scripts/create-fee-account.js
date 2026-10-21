// One-time setup: creates the treasury's wrapped-SOL token account, which receives Solana trading fees
// inside each Jupiter swap. Any funded wallet can pay the ~0.002 SOL rent; the account belongs to the treasury.
//
//   SETUP_PAYER_KEY=<base58 private key of the paying wallet> npm run setup:fee-account
require('dotenv').config();
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { config } = require('../src/config');
const { SOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, associatedTokenAddress } = require('../src/config/solana');

async function main() {
  if (!config.revenue.treasury) throw new Error('Set TREASURY_ADDRESS in .env first');
  if (!process.env.SETUP_PAYER_KEY) throw new Error('Set SETUP_PAYER_KEY to the base58 private key of the wallet paying the rent');

  const connection = new Connection(config.chain.rpcUrl, 'confirmed');
  const payer = Keypair.fromSecretKey(bs58.decode(process.env.SETUP_PAYER_KEY.trim()));
  const owner = new PublicKey(config.revenue.treasury);
  const account = associatedTokenAddress(owner, SOL_MINT);

  if (await connection.getAccountInfo(account)) {
    console.log(`✅ Fee account already exists: ${account.toBase58()}`);
    return;
  }

  // Associated Token Account program, instruction 1 = CreateIdempotent
  const ix = new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SOL_MINT), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.sign(payer);
  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`✅ Created fee account ${account.toBase58()} for treasury ${owner.toBase58()}`);
  console.log(`   ${config.chain.explorerUrl}/tx/${signature}`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});

const { PublicKey, SystemProgram, TransactionInstruction } = require('@solana/web3.js');
const connection = require('./connection');
const { ASSOCIATED_TOKEN_PROGRAM_ID, associatedTokenAddress } = require('../config/solana');

// Minimal SPL Token instructions (classic Token and Token-2022 share these layouts)

const u64 = (amount) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(amount));
  return b;
};

// Token program that owns a mint (Token or Token-2022)
async function tokenProgramOf(mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error('Mint not found');
  return info.owner.toBase58();
}

const ata = (owner, mint, program) => associatedTokenAddress(owner, mint, program);

// Creates the owner's associated token account if it doesn't exist (no-op otherwise)
function createAtaIdempotentIx(payer, owner, mint, program) {
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(program), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

// TransferChecked (instruction 12) between the owners' associated token accounts
function transferCheckedIx({ from, to, mint, amount, decimals, program }) {
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: ata(from, mint, program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: ata(to, mint, program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(from), isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  });
}

// BurnChecked (instruction 15): destroys tokens from the owner's associated token account
function burnCheckedIx({ owner, mint, amount, decimals, program }) {
  return new TransactionInstruction({
    programId: new PublicKey(program),
    keys: [
      { pubkey: ata(owner, mint, program), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([15]), u64(amount), Buffer.from([decimals])]),
  });
}

module.exports = { tokenProgramOf, createAtaIdempotentIx, transferCheckedIx, burnCheckedIx };

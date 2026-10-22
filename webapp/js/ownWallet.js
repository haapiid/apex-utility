import { api, short } from './lib.js';

// Trading from the user's own browser wallet. ApeX builds the swap (same routers and fee as ApeX wallets),
// the wallet shows it, signs and sends it, and ApeX then checks it on-chain before recording it.
// Only wallets proven by signing in / linking are offered (state.me.identities).

const WEB3_URL = 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.0/lib/index.iife.min.js';
let web3;

// @solana/web3.js is only needed to hand a Solana transaction to the wallet: loaded on first use
function loadWeb3() {
  web3 ||= new Promise((resolve, reject) => {
    if (window.solanaWeb3) return resolve(window.solanaWeb3);
    const s = document.createElement('script');
    s.src = WEB3_URL;
    s.onload = () => (window.solanaWeb3 ? resolve(window.solanaWeb3) : reject(new Error('Solana library did not load.')));
    s.onerror = () => {
      web3 = null;
      reject(new Error('Could not load the Solana library. Check your connection.'));
    };
    document.head.append(s);
  });
  return web3;
}

export function solanaProvider() {
  const p = window.phantom?.solana || window.solflare || window.solana;
  return p?.connect && p?.signAndSendTransaction ? p : null;
}

export const walletName = (kind) => (kind === 'sol' ? 'Phantom' : 'MetaMask');

// Proven wallets of a kind for the logged-in user
export const ownAddresses = (me, kind) => (me?.identities || []).filter((i) => i.provider === kind).map((i) => i.subject);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const rejected = (err) => err?.code === 4001 || /reject|denied|cancel/i.test(err?.message || '');

function friendly(err) {
  if (rejected(err)) return new Error('You cancelled it in your wallet.');
  return err instanceof Error ? err : new Error(String(err?.message || err));
}

// ---------- Solana ----------

async function solanaAccount(owner) {
  const provider = solanaProvider();
  if (!provider) throw new Error('No Solana wallet found. Install Phantom (phantom.com) and reload.');
  const res = await provider.connect();
  const address = (res?.publicKey || provider.publicKey).toString();
  if (address !== owner) throw new Error(`Your wallet is on ${short(address)}. Switch it to ${short(owner)} and try again.`);
  return provider;
}

async function sendSolana(prep, owner) {
  const provider = await solanaAccount(owner);
  const { VersionedTransaction } = await loadWeb3();
  const tx = VersionedTransaction.deserialize(base64ToBytes(prep.transaction));
  const out = await provider.signAndSendTransaction(tx);
  return typeof out === 'string' ? out : out.signature;
}

// ---------- EVM ----------

async function evmAccount(chain, owner) {
  const eth = window.ethereum;
  if (!eth?.request) throw new Error('No EVM wallet found. Install MetaMask (metamask.io) and reload.');
  const [address] = await eth.request({ method: 'eth_requestAccounts' });
  if (address.toLowerCase() !== owner.toLowerCase()) throw new Error(`Your wallet is on ${short(address)}. Switch it to ${short(owner)} and try again.`);
  const chainId = `0x${chain.chainId.toString(16)}`;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    if (err?.code === 4902) throw new Error(`Add ${chain.name} to your wallet first, then try again.`);
    throw err;
  }
  return eth;
}

async function evmSend(eth, owner, tx) {
  return eth.request({ method: 'eth_sendTransaction', params: [{ from: owner, to: tx.to, data: tx.data, ...(tx.value && tx.value !== '0x0' && { value: tx.value }) }] });
}

async function evmWait(eth, hash, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('The approval failed on-chain.');
      return receipt;
    }
    if (Date.now() > until) throw new Error('The approval is taking long. Try again once it confirms.');
    await sleep(2500);
  }
}

// ---------- public ----------

/**
 * Quote + build for the user's wallet. EVM sells may need an ERC-20 approval first: that is sent from the
 * wallet here (onStatus tells the UI), then the swap is built again on a fresh route.
 */
export async function prepareOwn({ chain, address, side, amount, owner, onStatus }) {
  const body = { chain: chain.key, address, side, amount, owner };
  try {
    let prep = await api('/api/self/prepare', { method: 'POST', body });
    if (prep.approve) {
      const eth = await evmAccount(chain, owner);
      onStatus?.(`Approve ${prep.token.symbol} in ${walletName('evm')}…`);
      const hash = await evmSend(eth, owner, prep.approve);
      onStatus?.('Waiting for the approval to confirm…');
      await evmWait(eth, hash);
      prep = await api('/api/self/prepare', { method: 'POST', body });
    }
    return prep;
  } catch (err) {
    throw friendly(err);
  }
}

/** Has the wallet sign and send the prepared swap, then lets ApeX verify and record it */
export async function sendOwn({ chain, prep, owner, onStatus }) {
  let signature;
  try {
    onStatus?.(`Confirm the swap in ${walletName(chain.kind)}…`);
    signature = chain.kind === 'sol' ? await sendSolana(prep, owner) : await evmSend(await evmAccount(chain, owner), owner, prep.tx);
  } catch (err) {
    throw friendly(err);
  }
  onStatus?.('Sent. Waiting for the chain to confirm…');
  return api('/api/self/confirm', { method: 'POST', body: { chain: chain.key, id: prep.id, signature } });
}

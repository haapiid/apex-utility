import { api, state } from './lib.js';

// Sign in (or link) with a browser wallet. The wallet only signs a text message from the server, which
// proves ownership; nothing is sent on-chain and no access to its funds is given.

const ref = () => {
  try {
    return localStorage.getItem('apex.ref') || undefined;
  } catch {
    return undefined;
  }
};

function solanaProvider() {
  const p = window.phantom?.solana || window.solflare || window.solana;
  return p?.connect && p?.signMessage ? p : null;
}

const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const utf8Hex = (text) => `0x${[...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

export async function signInWithWallet(kind) {
  let address;
  let sign;
  if (kind === 'sol') {
    const provider = solanaProvider();
    if (!provider) throw new Error('No Solana wallet found. Install Phantom (phantom.com) and reload.');
    const res = await provider.connect();
    address = (res?.publicKey || provider.publicKey).toString();
    sign = async (message) => {
      const out = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
      return bytesToBase64(out.signature || out);
    };
  } else {
    const eth = window.ethereum;
    if (!eth?.request) throw new Error('No EVM wallet found. Install MetaMask (metamask.io) and reload.');
    [address] = await eth.request({ method: 'eth_requestAccounts' });
    sign = (message) => eth.request({ method: 'personal_sign', params: [utf8Hex(message), address] });
  }
  const { message } = await api(`/api/auth/nonce?kind=${kind}&address=${encodeURIComponent(address)}`);
  const signature = await sign(message);
  return api('/api/auth/wallet', { method: 'POST', body: { kind, message, signature, ref: ref() } });
}

export const telegramLogin = (code) => api('/api/auth/login', { method: 'POST', body: { code } });

export function googleUrl() {
  const r = ref();
  return `/api/auth/google/start${r ? `?ref=${encodeURIComponent(r)}` : ''}`;
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST' });
  state.me = { user: null };
}

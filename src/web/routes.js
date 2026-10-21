const markets = require('../services/markets');
const marketData = require('../services/marketData');
const walletService = require('../services/walletService');
const settingsService = require('../services/settingsService');
const portfolioService = require('../services/portfolioService');
const automation = require('../services/automationService');
const rewardsService = require('../services/rewardsService');
const safetyService = require('../services/safetyService');
const webAuthService = require('../services/webAuthService');
const accountService = require('../services/accountService');
const notificationService = require('../services/notificationService');
const { withTimeout, UserError } = require('../services/tradeCommon');
const { config, isSolanaAddress } = require('../config');
const { allChains, getChain, isEvmAddress, txLink } = require('../config/chains');
const { toUnits } = require('../utils/format');
const { HttpError, sessionCookie } = require('./server');

// JSON API of ApeX Pro. Everything goes through the same services as the Telegram bot, so fees,
// settings, locks, positions and rewards are shared between the two.

const tradable = () => allChains().filter((c) => c.tradable);

function chainOf(key) {
  const chain = getChain(key);
  if (!chain?.tradable) throw new HttpError(400, 'Unknown chain');
  return chain;
}

function tokenAddress(chain, address) {
  const ok = chain.kind === 'sol' ? isSolanaAddress(address) : isEvmAddress(address);
  if (!ok) throw new HttpError(400, `Not a ${chain.name} token address`);
  return address;
}

function startSession(userId, req, setCookie) {
  const session = webAuthService.createSession(userId, req.headers['user-agent']);
  setCookie(sessionCookie(session.token, Math.floor((session.expiresAt - Date.now()) / 1000)));
}

const owner = (userId, chain) => (userId ? walletService.getWallet(userId, chain.kind)?.address : undefined);
const chainView = (c) => ({ key: c.key, name: c.name, kind: c.kind, native: c.native, decimals: c.decimals, buyPresets: c.buyPresets, claimMin: c.claimMin });
const tokenView = (t) => ({ address: t.address, name: t.name, symbol: t.symbol, decimals: t.decimals, balance: t.balance, usdPrice: t.usdPrice });

function quoteView(chain, side, q) {
  const base = { side, chain: chain.key, token: tokenView(q.token), fee: q.fee, minOut: q.minOut, priceImpactPct: q.priceImpactPct };
  if (side === 'buy') return { ...base, amountIn: q.amountIn, amountOut: q.amountOut };
  return { ...base, amountIn: q.amountIn, nativeOut: q.nativeOut, received: q.nativeOut - q.fee, percent: q.percent };
}

function tradeArgs(body) {
  const chain = chainOf(body.chain);
  const address = tokenAddress(chain, body.address);
  const side = body.side === 'sell' ? 'sell' : 'buy';
  if (side === 'sell') {
    const percent = Number(body.amount);
    if (!(Number.isInteger(percent) && percent >= 1 && percent <= 100)) throw new HttpError(400, 'Sell a whole percentage from 1 to 100');
    return { chain, address, side, amount: percent };
  }
  const amount = String(body.amount || '').trim();
  try {
    if (toUnits(amount, chain.decimals) <= 0n) throw new Error();
  } catch {
    throw new HttpError(400, `Invalid ${chain.native} amount`);
  }
  return { chain, address, side, amount };
}

// ---------- settings validation (same limits as the bot) ----------

function settingsPatch(body) {
  const { LIMITS, GAS_BOOST_STEPS } = settingsService;
  const patch = {};
  const inRange = (n, [min, max]) => Number.isFinite(n) && n >= min && n <= max;
  for (const key of ['mevProtect', 'confirmTrades', 'antiRug']) {
    if (key in body) patch[key] = Boolean(body[key]);
  }
  if (body.slippagePct) {
    for (const kind of ['sol', 'evm']) {
      if (body.slippagePct[kind] == null) continue;
      const n = Number(body.slippagePct[kind]);
      if (!inRange(n, LIMITS.slippagePct[kind])) throw new HttpError(400, `Slippage must be ${LIMITS.slippagePct[kind].join('–')}%`);
      patch.slippageBps = { ...patch.slippageBps, [kind]: Math.round(n * 100) };
    }
  }
  if (body.jitoTipSol != null) {
    const n = Number(body.jitoTipSol);
    if (!inRange(n, LIMITS.jitoTipSol)) throw new HttpError(400, `Jito tip must be ${LIMITS.jitoTipSol.join('–')} SOL`);
    patch.jitoTipLamports = Math.round(n * 1e9);
  }
  if (body.priorityMaxSol != null) {
    const n = Number(body.priorityMaxSol);
    if (!inRange(n, LIMITS.priorityMaxSol)) throw new HttpError(400, `Priority fee must be ${LIMITS.priorityMaxSol.join('–')} SOL`);
    patch.priorityMaxLamports = Math.round(n * 1e9);
  }
  if (body.gasBoostPct != null) {
    const n = Number(body.gasBoostPct);
    if (!GAS_BOOST_STEPS.includes(n)) throw new HttpError(400, `Gas boost must be one of ${GAS_BOOST_STEPS.join(', ')}`);
    patch.gasBoostPct = n;
  }
  if (body.antiRugDropPct != null) {
    const n = Number(body.antiRugDropPct);
    if (!inRange(n, LIMITS.antiRugDropPct)) throw new HttpError(400, `Anti-rug trigger must be ${LIMITS.antiRugDropPct.join('–')}%`);
    patch.antiRugDropPct = Math.round(n);
  }
  if (body.buyPresets) {
    for (const [key, values] of Object.entries(body.buyPresets)) {
      chainOf(key);
      const list = [].concat(values).map(String);
      if (!list.length || list.length > LIMITS.buyPresets || !list.every((v) => /^\d*\.?\d+$/.test(v) && Number(v) > 0)) {
        throw new HttpError(400, `Buy buttons: 1–${LIMITS.buyPresets} positive amounts`);
      }
      patch.buyPresets = { ...patch.buyPresets, [key]: list };
    }
  }
  if (body.sellPresets) {
    const list = [].concat(body.sellPresets).map(Number);
    if (!list.length || list.length > LIMITS.sellPresets || !list.every((v) => Number.isInteger(v) && v >= 1 && v <= 100)) {
      throw new HttpError(400, `Sell buttons: 1–${LIMITS.sellPresets} whole percentages`);
    }
    patch.sellPresets = list;
  }
  return patch;
}

function settingsView(userId) {
  const s = settingsService.get(userId);
  return {
    ...s,
    buyPresetsResolved: Object.fromEntries(tradable().map((c) => [c.key, settingsService.buyPresets(s, c)])),
  };
}

// ---------- routes ----------

function buildRoutes(app) {
  const r = (method, path, handler, auth = false) => ({ method, path, handler, auth });

  return [
    // --- public: config & market data ---
    r('GET', '/api/config', () => ({
      name: 'ApeX Pro',
      chains: tradable().map(chainView),
      fees: config.fees,
      botUsername: app.botUsername,
      loginLink: app.botUsername ? `https://t.me/${app.botUsername}?start=web` : null,
      googleEnabled: accountService.googleEnabled(),
      timeframes: Object.keys(marketData.TIMEFRAMES),
      trendingDurations: marketData.TRENDING_DURATIONS,
    })),

    r('GET', '/api/market/:list', async ({ params, query }) => {
      const chain = chainOf(query.chain || 'sol');
      if (params.list === 'trending') return marketData.trending(chain, query.duration);
      if (params.list === 'new') return marketData.newPairs(chain);
      if (params.list === 'boosted') return marketData.boosted(chain);
      throw new HttpError(404, 'Unknown list');
    }),

    r('GET', '/api/search', async ({ query }) => {
      const q = String(query.q || '').trim();
      if (q.length < 2) return [];
      if (isEvmAddress(q)) {
        const found = await markets.detectEvmChains(q);
        const rows = await Promise.all(found.map(async (c) => (await marketData.tokenOverview(c, q).catch(() => null)) || { chain: c.key, token: { address: q } }));
        return rows;
      }
      if (isSolanaAddress(q)) {
        const ov = await marketData.tokenOverview(getChain('sol'), q).catch(() => null);
        return [ov || { chain: 'sol', token: { address: q } }];
      }
      return marketData.search(q, tradable());
    }),

    r('GET', '/api/token/:chain/:address', async ({ params, userId }) => {
      const chain = chainOf(params.chain);
      const address = tokenAddress(chain, params.address);
      const svc = markets.serviceFor(chain);
      const [info, overview] = await Promise.all([
        svc.getTokenInfo(address, owner(userId, chain)),
        marketData.tokenOverview(chain, address).catch(() => null),
      ]);
      const safety = await withTimeout(
        safetyService.scan(chain, info, { canSell: async () => (await svc.quoteValue(info, 10n ** BigInt(info.decimals))) > 0n }),
        6_000,
      ).catch(() => null);
      return { chain: chain.key, info: tokenView(info), overview, safety };
    }),

    r('GET', '/api/token/:chain/:address/candles', async ({ params, query }) => {
      const chain = chainOf(params.chain);
      const address = tokenAddress(chain, params.address);
      const pool = query.pool || (await marketData.tokenOverview(chain, address))?.pool;
      if (!pool) return [];
      return marketData.candles(chain, pool, query.tf);
    }),

    r('GET', '/api/token/:chain/:address/trades', async ({ params, query }) => {
      const chain = chainOf(params.chain);
      const address = tokenAddress(chain, params.address);
      const pool = query.pool || (await marketData.tokenOverview(chain, address))?.pool;
      if (!pool) return [];
      return marketData.trades(chain, pool, address);
    }),

    // --- auth: Telegram code, wallet signature, Google. While logged in, each of them links instead. ---
    r('POST', '/api/auth/login', async ({ body, req, userId, setCookie, limited }) => {
      if (limited('login', 8)) throw new HttpError(429, 'Too many attempts. Wait a minute.');
      const telegramId = webAuthService.redeemLoginCode(body.code);
      if (!telegramId) throw new HttpError(400, 'That code is wrong or expired. Send /web to the bot for a new one.');
      // Linking Telegram to a web-only account folds it into the Telegram account (the bot keeps working)
      if (userId && userId !== telegramId) accountService.mergeUsers(userId, telegramId);
      startSession(telegramId, req, setCookie);
      return { ok: true, linked: Boolean(userId) };
    }),

    r('GET', '/api/auth/nonce', async ({ query, limited }) => {
      if (limited('nonce', 20)) throw new HttpError(429, 'Too many attempts. Wait a minute.');
      return accountService.walletChallenge(query.kind, query.address);
    }),

    r('POST', '/api/auth/wallet', async ({ body, req, userId, setCookie, limited }) => {
      if (limited('login', 8)) throw new HttpError(429, 'Too many attempts. Wait a minute.');
      const { userId: id, created } = accountService.walletLogin({
        kind: body.kind,
        message: body.message,
        signature: body.signature,
        currentUserId: userId,
        ref: body.ref,
      });
      startSession(id, req, setCookie);
      return { ok: true, created };
    }),

    r('GET', '/api/auth/google/start', async ({ userId, query }) => ({
      redirect: accountService.googleStart({ currentUserId: userId, ref: query.ref }),
    })),

    r('GET', '/api/auth/google/callback', async ({ query, req, setCookie }) => {
      if (query.error) return { redirect: '/#/login?error=google' };
      try {
        const { userId } = await accountService.googleCallback({ code: query.code, state: query.state });
        startSession(userId, req, setCookie);
        return { redirect: '/#/account' };
      } catch (err) {
        return { redirect: `/#/login?error=${encodeURIComponent(err instanceof UserError ? err.message : 'Google sign-in failed')}` };
      }
    }),

    r('POST', '/api/auth/logout', async ({ sessionToken, setCookie }) => {
      webAuthService.revokeSession(sessionToken);
      setCookie(sessionCookie('', 0));
      return { ok: true };
    }),

    r('GET', '/api/me', async ({ userId }) => {
      if (!userId) return { user: null };
      const { credits, extra_wallet_slots: slots } = rewardsService.credits(userId);
      return {
        user: { id: userId, telegram: userId > 0 },
        identities: accountService.identities(userId).list,
        unread: notificationService.unread(userId),
        wallets: walletService.listWallets(userId),
        walletLimit: walletService.walletLimit(userId),
        settings: settingsView(userId),
        credits,
        extraWalletSlots: slots,
      };
    }),

    // --- account & notifications ---
    r(
      'POST',
      '/api/account/unlink',
      async ({ userId, body }) => {
        if (!accountService.PROVIDERS.includes(body.provider)) throw new HttpError(400, 'Unknown login method');
        return { ok: accountService.unlinkIdentity(userId, body.provider, String(body.subject || '')) };
      },
      true,
    ),
    r('GET', '/api/notifications', async ({ userId }) => notificationService.list(userId), true),
    r('POST', '/api/notifications/read', async ({ userId }) => (notificationService.markRead(userId), { ok: true }), true),

    // --- wallets ---
    r(
      'GET',
      '/api/balances',
      async ({ userId }) => {
        const wallets = walletService.getWallets(userId);
        const out = {};
        await Promise.all(
          tradable().map(async (c) => {
            const w = wallets[c.kind];
            if (!w) return;
            out[c.key] = await withTimeout(markets.serviceFor(c).getNativeBalance(w.address), 8_000).catch(() => null);
          }),
        );
        return out;
      },
      true,
    ),
    r(
      'POST',
      '/api/wallets',
      async ({ userId, body }) => {
        if (!['sol', 'evm'].includes(body.kind)) throw new HttpError(400, 'kind must be sol or evm');
        try {
          return walletService.createWallet(userId, body.kind);
        } catch (err) {
          if (err.code === 'limit') throw new UserError(`You can have up to ${walletService.walletLimit(userId)} wallets of this kind.`);
          throw err;
        }
      },
      true,
    ),
    // Web-only users have no bot to export from, so the key can be shown here after typing EXPORT
    r(
      'POST',
      '/api/wallets/:id/export',
      async ({ userId, params, body, limited }) => {
        if (limited('export', 5, 10 * 60_000)) throw new HttpError(429, 'Too many exports. Try again later.');
        if (body.confirm !== 'EXPORT') throw new HttpError(400, 'Type EXPORT to confirm.');
        const wallet = walletService.getWalletById(userId, Number(params.id));
        if (!wallet) throw new HttpError(404, 'Wallet not found');
        return { kind: wallet.kind, address: wallet.address, privateKey: walletService.exportPrivateKey(userId, wallet.id) };
      },
      true,
    ),
    r(
      'POST',
      '/api/wallets/:id/active',
      async ({ userId, params }) => {
        const w = walletService.setActive(userId, Number(params.id));
        if (!w) throw new HttpError(404, 'Wallet not found');
        return w;
      },
      true,
    ),

    // --- trading ---
    r(
      'POST',
      '/api/quote',
      async ({ userId, body }) => {
        const { chain, address, side, amount } = tradeArgs(body);
        const wallet = walletService.getWallet(userId, chain.kind);
        if (!wallet) throw new UserError(`Create a ${walletService.KIND_LABEL[chain.kind]} wallet first.`);
        const svc = markets.serviceFor(chain);
        const opts = settingsService.tradeOptions(userId, chain, 'manual');
        const q = side === 'buy' ? await svc.quoteBuy(address, amount, wallet.address, opts) : await svc.quoteSell(address, amount, wallet.address, opts);
        return { ...quoteView(chain, side, q), wallet: { label: wallet.label, address: wallet.address }, slippageBps: opts.slippageBps, mevProtect: opts.mevProtect, mev: markets.mevLabel(chain) };
      },
      true,
    ),
    r(
      'POST',
      '/api/trade',
      async ({ userId, body, limited }) => {
        if (limited('trade', 20)) throw new HttpError(429, 'Too many trades in a minute.');
        const { chain, address, side, amount } = tradeArgs(body);
        const svc = markets.serviceFor(chain);
        const result = side === 'buy' ? await svc.executeBuy(userId, address, amount) : await svc.executeSell(userId, address, amount);
        return { signature: result.signature, txUrl: txLink(chain, result.signature), received: result.received ?? null, chain: chain.key };
      },
      true,
    ),

    r(
      'GET',
      '/api/positions',
      async ({ userId }) => {
        const { rows, truncated } = await portfolioService.getPortfolio(userId);
        return { truncated, rows: rows.map((row) => ({ ...row, chain: row.chain.key })) };
      },
      true,
    ),

    // --- automation ---
    r(
      'GET',
      '/api/orders',
      async ({ userId }) => ({
        orders: automation.listOrders(userId),
        dca: automation.listDca(userId),
        snipes: automation.listSnipes(userId),
        copy: automation.listCopyTargets(userId),
      }),
      true,
    ),
    r(
      'POST',
      '/api/orders',
      async ({ userId, body }) => {
        const chain = chainOf(body.chain);
        return automation.createOrder(userId, chain, tokenAddress(chain, body.address), body.type, body.amount, body.move);
      },
      true,
    ),
    r(
      'POST',
      '/api/dca',
      async ({ userId, body }) => {
        const chain = chainOf(body.chain);
        const { plan } = await automation.createDca(userId, chain, tokenAddress(chain, body.address), body.side, body.amount, body.runs, body.interval);
        return plan;
      },
      true,
    ),
    r(
      'POST',
      '/api/snipes',
      async ({ userId, body }) => {
        const chain = chainOf(body.chain);
        return automation.createSnipe(userId, chain, body.address, body.amount, body.safety !== false);
      },
      true,
    ),
    r(
      'POST',
      '/api/copy',
      async ({ userId, body }) => automation.addCopyTarget(userId, chainOf(body.chain), String(body.address || '').trim(), body.amount),
      true,
    ),
    r(
      'POST',
      '/api/copy/:id',
      async ({ userId, params, body }) => {
        const fields = {};
        if ('active' in body) fields.active = body.active ? 1 : 0;
        if ('copySells' in body) fields.copy_sells = body.copySells ? 1 : 0;
        if (!automation.updateCopyTarget(userId, Number(params.id), fields)) throw new HttpError(404, 'Not found');
        return automation.getCopyTarget(userId, Number(params.id));
      },
      true,
    ),
    r(
      'POST',
      '/api/cancel/:kind/:id',
      async ({ userId, params }) => {
        const cancel = { order: automation.cancelOrder, dca: automation.cancelDca, snipe: automation.cancelSnipe, copy: automation.removeCopyTarget }[params.kind];
        if (!cancel) throw new HttpError(404, 'Unknown kind');
        return { ok: cancel(userId, Number(params.id)) };
      },
      true,
    ),

    // --- rewards ---
    r(
      'GET',
      '/api/rewards',
      async ({ userId }) => {
        const code = rewardsService.refCode(userId);
        const { invited, earned } = rewardsService.referralStats(userId);
        return {
          balances: rewardsService.nativeBalances(userId),
          cashback: rewardsService.cashbackBalance(userId),
          credits: rewardsService.credits(userId),
          referral: {
            code,
            link: app.botUsername ? `https://t.me/${app.botUsername}?start=ref_${code}` : null,
            webLink: `${config.web.publicUrl}/?ref=${code}`,
            invited,
            earned,
            shareBps: config.referral.shareBps,
          },
          pools: rewardsService.pools(),
          nextEpochAt: rewardsService.nextEpochAt(),
          epochHours: config.revenue.epochHours,
          apexLive: Boolean(rewardsService.apexToken()),
          minHold: config.apex.minHold,
          revenueShareBps: config.revenue.revenueShareBps,
          slotCost: config.apex.walletSlotCredits,
        };
      },
      true,
    ),
    r(
      'POST',
      '/api/rewards/claim',
      async ({ userId, body }) => {
        const result = await rewardsService.claimNative(userId, body.chain);
        return { amount: result.amount, chain: result.chain.key, txUrl: txLink(result.chain, result.signature) };
      },
      true,
    ),
    r(
      'POST',
      '/api/rewards/cashback',
      async ({ userId }) => {
        const result = await rewardsService.claimCashback(userId);
        return { amount: result.amount, decimals: result.decimals, usd: result.usd, txUrl: txLink(result.chain, result.signature) };
      },
      true,
    ),
    r('POST', '/api/rewards/slot', async ({ userId }) => rewardsService.buyWalletSlot(userId), true),

    // --- settings ---
    r('GET', '/api/settings', async ({ userId }) => settingsView(userId), true),
    r(
      'POST',
      '/api/settings',
      async ({ userId, body }) => {
        if (body.reset) settingsService.reset(userId);
        else settingsService.update(userId, settingsPatch(body));
        return settingsView(userId);
      },
      true,
    ),
  ];
}

module.exports = { buildRoutes };

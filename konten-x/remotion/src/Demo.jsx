import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { C, FONT, MONO, CHAINS, BOT, SITE } from './theme';
import { RiseLine, FadeUp, Mascot, Wordmark, Phone, MeMsg, BotMsg, Browser, ease, useProgress } from './parts';

// 16:9 demo for X, ~37 s, no audio. Real product screens: the bot replay uses the bot's own messages
// (sample token BONK), ApeX Pro scenes are screenshots of pro.apexutility.fun.

export const DEMO_FPS = 30;
const SCENES = [
  ['intro', 120],
  ['bot', 270],
  ['chains', 120],
  ['sniper', 180],
  ['pro', 225],
  ['safety', 105],
  ['cta', 120],
];
export const DEMO_FRAMES = SCENES.reduce((s, [, d]) => s + d, 0);

// Each scene fades / slides in and out over 12 frames
function Scene({ dur, dark, children }) {
  const f = useCurrentFrame();
  const inP = interpolate(f, [0, 12], [0, 1], { extrapolateRight: 'clamp', easing: ease });
  const outP = interpolate(f, [dur - 12, dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  return (
    <AbsoluteFill style={{ background: dark ? C.ink : C.ivory, color: dark ? C.ivory : C.ink, fontFamily: FONT, opacity: inP * (1 - outP), transform: `translateY(${(1 - inP) * 30 - outP * 30}px)` }}>
      {children}
    </AbsoluteFill>
  );
}

const H = ({ children, size = 96, style }) => <div style={{ fontWeight: 900, fontSize: size, letterSpacing: '-0.045em', lineHeight: 0.95, ...style }}>{children}</div>;
const Sub = ({ children, style }) => <div style={{ fontSize: 34, lineHeight: 1.35, color: '#5F5B51', maxWidth: 760, ...style }}>{children}</div>;

function Intro() {
  return (
    <Scene dur={120}>
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 60 }}>
        <Mascot size={520} from={6} />
        <div>
          <RiseLine from={10}><Wordmark size={130} accent={C.ink} /></RiseLine>
          <RiseLine from={20}><H size={88} style={{ marginTop: 18 }}>Trade smart. <span style={{ background: C.yellow, padding: '0 14px', borderRadius: 12 }}>Stay ahead.</span></H></RiseLine>
          <FadeUp from={34}><Sub style={{ marginTop: 26 }}>A multi-chain trading bot on Telegram, and ApeX Pro in your browser.</Sub></FadeUp>
        </div>
      </AbsoluteFill>
    </Scene>
  );
}

function BotFlow() {
  const f = useCurrentFrame();
  const step = f < 70 ? 0 : f < 150 ? 1 : f < 200 ? 2 : 3;
  const paste = useProgress(14, 14);
  const card = useProgress(40, 16);
  return (
    <Scene dur={270}>
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 110 }}>
        <div style={{ width: 640 }}>
          <RiseLine from={4}><H>Paste a token.</H></RiseLine>
          <RiseLine from={12}><H>Tap Buy.</H></RiseLine>
          <FadeUp from={24}><Sub style={{ marginTop: 28 }}>The bot finds the chain, runs a safety scan and shows the fee, the minimum you get and the price impact before anything is sent.</Sub></FadeUp>
          <FadeUp from={36}><div style={{ marginTop: 28, fontFamily: MONO, fontSize: 24, color: C.ink }}>Solana via Jupiter · EVM via KyberSwap</div></FadeUp>
        </div>
        <Phone width={600} height={900}>
          <MeMsg style={{ opacity: paste, transform: `translateY(${(1 - paste) * 20}px)` }}>DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</MeMsg>
          {step <= 1 && (
            <BotMsg
              style={{ opacity: card }}
              text={step === 0
                ? '🍌 Bonk ($Bonk) • ⛓ Solana\n💵 Price: $0.000003\n📊 Market cap: $266M\n🛡️ Safety scan: no red flags\n\n💰 Wallet: 2.45 SOL\nFee 0.5% • Slippage 5% • via Jupiter\n🛡️ MEV protection: ON (Jito)'
                : '🟢 Confirm Buy — $Bonk • ⛓ Solana\n\n💸 You pay: 0.5 SOL\n🍌 Fee (0.5%): 0.0025 SOL\n🛡️ Min. received (5% slippage)\n📉 Price impact: 0.03%\n🥷 MEV protection: Jito'}
              keys={step === 0 ? [['🟢 Buy 0.1 SOL', '🟢 Buy 0.25 SOL', '🟢 Buy 0.5 SOL'], ['🔴 Sell 25%', '🔴 Sell 50%', '🔴 Sell 100%'], ['🎯 Limit / TP / SL', '🔁 DCA', '⭐ Watch']] : [['⚡ Confirm', '❌ Cancel']]}
              pressed={step === 0 && f > 55 ? '🟢 Buy 0.5 SOL' : step === 1 && f > 130 ? '⚡ Confirm' : null}
            />
          )}
          {step === 2 && <BotMsg text={'🚀 Submitted — 5VfY…xB1cD\n⏳ Confirming…'} />}
          {step === 3 && <BotMsg text={'✅ Bought $Bonk! • ⛓ Solana\n\nSpent 0.5 SOL\n🔗 View transaction'} keys={[['🍌 Open Token', '📊 Positions', '🏠 Menu']]} />}
        </Phone>
      </AbsoluteFill>
    </Scene>
  );
}

function Chains() {
  return (
    <Scene dur={120} dark>
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
        <RiseLine from={4}><H size={120} style={{ color: C.yellow }}>7 chains. One bot.</H></RiseLine>
        <div style={{ marginTop: 56, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '18px 22px', maxWidth: 1400 }}>
          {CHAINS.map((c, i) => (
            <FadeUp key={c} from={16 + i * 5} dy={30}>
              <div style={{ fontWeight: 800, fontSize: 46, padding: '14px 30px', borderRadius: 999, border: `3px solid ${C.ink2}`, background: C.ink2 }}>{c}</div>
            </FadeUp>
          ))}
        </div>
        <FadeUp from={60}><div style={{ marginTop: 50, fontSize: 30, color: '#B9B3A5' }}>One Solana wallet and one EVM wallet cover them all.</div></FadeUp>
      </AbsoluteFill>
    </Scene>
  );
}

function Sniper() {
  const f = useCurrentFrame();
  const a = useProgress(16, 14);
  const b = useProgress(40, 16);
  const c = useProgress(110, 16);
  return (
    <Scene dur={180}>
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 110 }}>
        <div style={{ width: 660 }}>
          <RiseLine from={4}><H>Snipe pump.fun</H></RiseLine>
          <RiseLine from={12}><H>launches and</H></RiseLine>
          <RiseLine from={20}><H>migrations.</H></RiseLine>
          <FadeUp from={32}><Sub style={{ marginTop: 28 }}>Filters for name and dev buy, a budget cap on every rule, and a safety filter that skips freeze authority and transfer fees.</Sub></FadeUp>
        </div>
        <Phone width={600} height={900}>
          <MeMsg style={{ opacity: a, fontSize: 20 }}>/pump launch 0.05 max=3 dev=5</MeMsg>
          <BotMsg style={{ opacity: b, transform: `translateY(${(1 - b) * 20}px)` }} text={'💊 Rule armed\n\n🚀 New launches: 0.05 SOL each, 0/3 bought • dev buy ≤ 5%\n\nBuys new pump.fun launches for 0.05 SOL each until 3 are bought.'} />
          {f > 100 && <BotMsg style={{ opacity: c, transform: `translateY(${(1 - c) * 20}px)` }} text={'✅ 💊 pump.fun launch snipe: bought for 0.05 SOL!\n🔗 View transaction\n2 buys left on this rule.'} />}
        </Phone>
      </AbsoluteFill>
    </Scene>
  );
}

function Pro() {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const swap = interpolate(f, [110, 126], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
  const zoomA = interpolate(f, [0, 126], [1, 1.08]);
  const zoomB = interpolate(f, [110, 225], [1, 1.06], { extrapolateLeft: 'clamp' });
  return (
    <Scene dur={225} dark>
      <AbsoluteFill style={{ alignItems: 'center', paddingTop: 70 }}>
        <RiseLine from={4}><H size={84} style={{ textAlign: 'center' }}>ApeX Pro: <span style={{ color: C.yellow }}>trade in your browser.</span></H></RiseLine>
        <div style={{ marginTop: 26, fontSize: 30, color: '#B9B3A5', textAlign: 'center', height: 40 }}>
          {f < 118 ? 'Live charts, trades, top traders and holder metrics. Log in with a wallet, no Telegram needed.' : 'Bubble map: wallets funded by the same source are linked and coloured.'}
        </div>
        <div style={{ position: 'relative', marginTop: 34, width: 1500, height: 760 }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - swap }}>
            <Browser src="shots/token.png" width={1500} height={760} zoom={zoomA} />
          </div>
          <div style={{ position: 'absolute', inset: 0, opacity: swap }}>
            <Browser src="shots/bubbles.png" width={1500} height={760} zoom={zoomB} />
          </div>
        </div>
      </AbsoluteFill>
    </Scene>
  );
}

const SAFETY = ['Safety scan before every buy', 'MEV protection: Jito, Flashbots, PancakeSwap MEV Guard', 'Anti-rug: sells if a bag suddenly collapses', 'Price impact limit (stop losses still go through)', 'Encrypted keys, export any time, security PIN'];

function Safety() {
  return (
    <Scene dur={105}>
      <AbsoluteFill style={{ justifyContent: 'center', paddingLeft: 230 }}>
        <RiseLine from={2}><H>Built to protect your bag.</H></RiseLine>
        <div style={{ marginTop: 40, display: 'grid', gap: 18 }}>
          {SAFETY.map((s, i) => (
            <FadeUp key={s} from={12 + i * 6} dy={20}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 38, fontWeight: 600 }}>
                <span style={{ width: 40, height: 40, borderRadius: 10, background: C.yellow, display: 'grid', placeItems: 'center', fontSize: 26, fontWeight: 900 }}>✓</span>
                {s}
              </div>
            </FadeUp>
          ))}
        </div>
      </AbsoluteFill>
    </Scene>
  );
}

function Cta() {
  return (
    <Scene dur={120} dark>
      <AbsoluteFill style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 70 }}>
        <Mascot size={480} from={4} />
        <div>
          <RiseLine from={8}><Wordmark size={120} color={C.ivory} /></RiseLine>
          <FadeUp from={20}><div style={{ marginTop: 30, fontSize: 40, fontWeight: 700 }}>Start on Telegram</div></FadeUp>
          <FadeUp from={26}><div style={{ marginTop: 10, fontFamily: MONO, fontSize: 44, color: C.yellow }}>{BOT}</div></FadeUp>
          <FadeUp from={34}><div style={{ marginTop: 26, fontSize: 34, color: '#B9B3A5' }}>or open ApeX Pro at <span style={{ color: C.ivory, fontWeight: 700 }}>{SITE}</span></div></FadeUp>
          <FadeUp from={44}><div style={{ marginTop: 30, fontSize: 22, color: '#8A857A' }}>0.5% per trade. Crypto is risky: only trade what you can afford to lose.</div></FadeUp>
        </div>
      </AbsoluteFill>
    </Scene>
  );
}

const VIEWS = { intro: Intro, bot: BotFlow, chains: Chains, sniper: Sniper, pro: Pro, safety: Safety, cta: Cta };

export function Demo() {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: C.ink }}>
      {SCENES.map(([name, dur]) => {
        const View = VIEWS[name];
        const seq = (
          <Sequence key={name} from={from} durationInFrames={dur}>
            <View />
          </Sequence>
        );
        from += dur;
        return seq;
      })}
    </AbsoluteFill>
  );
}

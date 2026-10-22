import React from 'react';
import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
import { C, FONT } from './theme';
import { Phone, MeMsg, BotMsg, ease } from './parts';

// Square GIF for posts (loops): paste a token address → tap Buy → bought. Starts and ends on the same
// empty chat, so the loop has no jump.
export const GIF_FPS = 20;
export const GIF_FRAMES = 100; // 5 s

const at = (frame, a, b) => interpolate(frame, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });

export function PostGif() {
  const f = useCurrentFrame();
  const paste = at(f, 6, 14);
  const card = at(f, 18, 28);
  const done = at(f, 52, 60);
  const out = at(f, 88, 98); // everything leaves before the loop restarts
  const show = 1 - out;
  return (
    <AbsoluteFill style={{ background: C.ivory, alignItems: 'center', justifyContent: 'center', fontFamily: FONT }}>
      <div style={{ position: 'absolute', top: 64, left: 0, right: 0, textAlign: 'center', fontWeight: 900, fontSize: 64, letterSpacing: '-0.04em', color: C.ink }}>
        Paste. Tap Buy. <span style={{ background: C.yellow, padding: '0 12px', borderRadius: 10 }}>Done.</span>
      </div>
      <div style={{ marginTop: 120 }}>
        <Phone width={560} height={800}>
          <MeMsg style={{ opacity: paste * show, transform: `translateY(${(1 - paste) * 20}px)` }}>DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</MeMsg>
          {f < 52 ? (
            <BotMsg
              style={{ opacity: card * show, transform: `translateY(${(1 - card) * 24}px)` }}
              text={'🍌 Bonk ($Bonk) • ⛓ Solana\n💵 Price: $0.000003\n🛡️ Safety scan: no red flags\n\nFee 0.5% • Slippage 5% • via Jupiter\n🛡️ MEV protection: ON (Jito)'}
              keys={[['🟢 Buy 0.1 SOL', '🟢 Buy 0.25 SOL', '🟢 Buy 0.5 SOL'], ['🔴 Sell 25%', '🔴 Sell 50%', '🔴 Sell 100%']]}
              pressed={f > 40 ? '🟢 Buy 0.5 SOL' : null}
            />
          ) : (
            <BotMsg
              style={{ opacity: done * show, transform: `scale(${0.96 + done * 0.04})`, transformOrigin: 'left bottom' }}
              text={'✅ Bought $Bonk! • ⛓ Solana\n\nSpent 0.5 SOL\n🔗 View transaction'}
              keys={[['🍌 Open Token', '📊 Positions', '🏠 Menu']]}
            />
          )}
        </Phone>
      </div>
    </AbsoluteFill>
  );
}

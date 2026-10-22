import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { C, FONT, MONO, CHAINS, BOT, SITE } from './theme';

// X profile picture, 400×400: the approved mascot on brand yellow, centred for X's circle crop
export function LogoX() {
  return (
    <AbsoluteFill style={{ background: C.yellow, alignItems: 'center', justifyContent: 'center' }}>
      <Img src={staticFile('mascot-hero.png')} style={{ width: 372, height: 372, marginTop: 34 }} />
    </AbsoluteFill>
  );
}

// X header, 1500×500. X lays the profile picture over the bottom-left, so the left third stays quiet
// and the copy sits in the middle; the mascot stands on the bottom edge at the right.
export function BannerX() {
  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: FONT, color: C.ivory, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', left: 450, top: 92, width: 700 }}>
        <div style={{ fontWeight: 900, fontSize: 92, letterSpacing: '-0.05em', lineHeight: 0.9 }}>
          Trade smart.
          <br />
          <span style={{ color: C.yellow }}>Stay ahead.</span>
        </div>
        <div style={{ marginTop: 26, fontSize: 25, lineHeight: 1.35, color: '#D9D3C6', maxWidth: 600 }}>
          Multi-chain trading bot on Telegram, and ApeX Pro in your browser. Snipe, limit, DCA, copy trade.
        </div>
        <div style={{ marginTop: 22, display: 'flex', flexWrap: 'wrap', gap: '6px 0', fontWeight: 700, fontSize: 18, color: C.ivory }}>
          {CHAINS.map((c, i) => (
            <span key={c}>
              {c}
              {i < CHAINS.length - 1 ? <span style={{ color: C.yellow, margin: '0 9px' }}>·</span> : null}
            </span>
          ))}
        </div>
      </div>
      <div style={{ position: 'absolute', right: 40, top: 34, fontFamily: MONO, fontSize: 19, color: C.muted, textAlign: 'right', lineHeight: 1.6 }}>
        {SITE}
        <br />
        {BOT}
      </div>
      <Img src={staticFile('mascot-hero.png')} style={{ position: 'absolute', right: 40, bottom: -8, width: 360, height: 360 }} />
    </AbsoluteFill>
  );
}

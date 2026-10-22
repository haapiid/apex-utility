import React from 'react';
import { Img, staticFile, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import { C, FONT, MONO } from './theme';

// Shared pieces: animated text, the Telegram phone (real bot screens, sample token BONK), a browser frame.

export const ease = Easing.bezier(0.16, 1, 0.3, 1);

// 0 → 1 over `dur` frames starting at `from`
export function useProgress(from, dur = 18) {
  const frame = useCurrentFrame();
  return interpolate(frame, [from, from + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease });
}

// A line that rises out of its own mask (same motion as the landing page headline)
export function RiseLine({ children, from = 0, style }) {
  const p = useProgress(from, 22);
  return (
    <div style={{ overflow: 'hidden', paddingBottom: '0.08em', marginBottom: '-0.08em' }}>
      <div style={{ transform: `translateY(${(1 - p) * 105}%)`, ...style }}>{children}</div>
    </div>
  );
}

export function FadeUp({ children, from = 0, dy = 24, style }) {
  const p = useProgress(from, 20);
  return <div style={{ opacity: p, transform: `translateY(${(1 - p) * dy}px)`, ...style }}>{children}</div>;
}

export function Mascot({ size = 420, from = 0, style }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - from, fps, config: { damping: 14, stiffness: 120 } });
  return (
    <Img
      src={staticFile('mascot-hero.png')}
      style={{ width: size, height: size, transform: `translateY(${(1 - s) * 60}px) rotate(${(1 - s) * -4}deg)`, opacity: Math.min(1, s * 1.4), transformOrigin: '50% 100%', ...style }}
    />
  );
}

export function Wordmark({ size = 120, color = C.ink, accent = C.yellow }) {
  return (
    <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: size, letterSpacing: '-0.05em', lineHeight: 0.9, color }}>
      ApeX <span style={{ color: accent }}>Utility</span>
    </div>
  );
}

// ---------- Telegram phone ----------

const bubble = { background: '#FFFFFF', borderRadius: '18px 18px 18px 6px', padding: '12px 16px', fontSize: 21, lineHeight: 1.42, color: '#1A1E17', whiteSpace: 'pre-wrap', boxShadow: '0 1px 1px rgba(0,0,0,0.08)' };
const key = { flex: 1, textAlign: 'center', padding: '12px 4px', borderRadius: 14, background: 'rgba(255,255,255,0.62)', fontSize: 18, fontWeight: 600, color: '#1A1E17', whiteSpace: 'nowrap' };

export function Phone({ children, width = 560, height = 860 }) {
  return (
    <div style={{ width, height, background: C.tgBg, borderRadius: 40, overflow: 'hidden', boxShadow: '0 40px 80px -40px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, Segoe UI, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 20px', background: C.ink, color: C.ivory }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: C.yellow, display: 'grid', placeItems: 'center' }}>
          <Img src={staticFile('face-mark.png')} style={{ width: 42 }} />
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 22 }}>ApeX Utility</div>
          <div style={{ opacity: 0.7, fontSize: 17 }}>bot</div>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 12, padding: 16 }}>{children}</div>
    </div>
  );
}

export const MeMsg = ({ children, style }) => (
  <div style={{ alignSelf: 'flex-end', maxWidth: '92%', ...style }}>
    <div style={{ ...bubble, background: '#E4F6CC', borderRadius: '18px 18px 6px 18px', fontFamily: MONO, fontSize: 16 }}>{children}</div>
  </div>
);

export const BotMsg = ({ text, keys = [], pressed, style }) => (
  <div style={{ maxWidth: '94%', display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
    <div style={bubble}>{text}</div>
    {keys.map((row, i) => (
      <div key={i} style={{ display: 'flex', gap: 6 }}>
        {row.map((k) => (
          <div key={k} style={{ ...key, ...(k === pressed && { background: '#FFFFFF', boxShadow: `0 0 0 3px ${C.ink} inset` }) }}>{k}</div>
        ))}
      </div>
    ))}
  </div>
);

// ---------- Browser frame around a real ApeX Pro screenshot ----------

export function Browser({ src, width = 1500, height = 844, zoom = 1, x = 0, y = 0, url = 'pro.apexutility.fun' }) {
  return (
    <div style={{ width, height, borderRadius: 22, overflow: 'hidden', background: '#0E0E0C', boxShadow: '0 50px 100px -40px rgba(0,0,0,0.7)', border: `2px solid ${C.ink2}` }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', background: C.ink2 }}>
        {['#F0616D', '#F2C94C', '#3DD68C'].map((c) => <div key={c} style={{ width: 14, height: 14, borderRadius: '50%', background: c }} />)}
        <div style={{ marginLeft: 18, padding: '6px 18px', borderRadius: 8, background: '#0E0E0C', color: C.muted, fontFamily: MONO, fontSize: 18 }}>🔒 {url}</div>
      </div>
      <div style={{ width, height: height - 52, overflow: 'hidden' }}>
        <Img src={staticFile(src)} style={{ width, transform: `scale(${zoom}) translate(${x}px, ${y}px)`, transformOrigin: '0 0' }} />
      </div>
    </div>
  );
}

// ApeX Utility site
// - Revenue calculator (works without GSAP)
// - Hero: real trade replay; the load sequence itself is pure CSS (styles.css)
// - Scroll layer (GSAP + ScrollTrigger): receding hero,
//   masked heading lines, rows arriving per section, footer wordmark.
// Every hidden state is created by script under prefers-reduced-motion: no-preference,
// so without JS or with reduced motion the page is simply the finished page.

// Same model as the bot's /revenue calculator (.env): FEE_MANUAL_BPS=50, REVENUE_SHARE_BPS=4000,
// holders split by holdings, assuming no referred volume
const MODEL = { fee: 0.005, share: 0.4, totalSupply: 1_000_000 };
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const fmt = (n, max = 4) => new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(n);
const fmtUsd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 }).format(n);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- calculator
function setupCalculator(gsap) {
  const platform = $('#c-platform');
  const hold = $('#c-hold');
  if (!platform) return;

  // Results glide to their new value instead of jumping (feedback on the live thing)
  const shown = new Map();
  function setValue(el, value, format) {
    const from = shown.get(el) ?? value;
    shown.set(el, value);
    if (!gsap || REDUCED || from === value) { el.textContent = format(value); return; }
    const proxy = { v: from };
    gsap.to(proxy, { v: value, duration: 0.35, ease: 'power2.out', overwrite: true, onUpdate: () => { el.textContent = format(proxy.v); } });
  }

  function update() {
    const p = Number(platform.value);
    const h = Number(hold.value);

    const fees = p * MODEL.fee;
    const holderPool = fees * MODEL.share;
    const daily = holderPool * (h / MODEL.totalSupply);

    $('#o-platform').textContent = fmtUsd(p);
    $('#o-hold').textContent = `${fmt(h)} of ${fmt(MODEL.totalSupply)}`;
    setValue($('#r-daily'), daily, fmtUsd);
    setValue($('#r-month'), daily * 30, fmtUsd);
    $('#r-detail').textContent = `Holder pool ${fmtUsd(holderPool)} a day (40% of ${fmtUsd(fees)} in fees).`;
  }

  [platform, hold].forEach((el) => el.addEventListener('input', update));
  $('#calc').addEventListener('submit', (e) => e.preventDefault());
  update();
}

// ---------------------------------------------------------------- ApeX Pro links
// On localhost / the LAN, ApeX Pro runs next to this site on port 8080; elsewhere the HTML's href is used
function proLinks() {
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
  if (!local) return;
  $$('[data-pro]').forEach((a) => { a.href = `http://${host}:8080/`; });
}

// ---------------------------------------------------------------- sticky bar
// Hairline once the page scrolls, the menu closes after a pick, and the section in view is marked
function bar() {
  const el = $('.bar');
  if (!el) return;
  const onScroll = () => el.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const menu = $('.menu');
  menu?.addEventListener('click', (e) => { if (e.target.closest('a')) menu.open = false; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu?.open) menu.open = false; });

  const links = new Map($$('.bar > nav a[href^="#"]').map((a) => [a.getAttribute('href').slice(1), a]));
  if (!links.size || !('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.removeAttribute('aria-current'));
      links.get(e.target.id)?.setAttribute('aria-current', 'true');
    }
  }, { rootMargin: '-45% 0px -50% 0px' });
  links.forEach((_, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
}

// ---------------------------------------------------------------- hero replay
const SCREENS = {
  card: $('#demo-text')?.innerHTML,
  confirm: `🟢 <b>Confirm Buy — $Bonk</b> • ⛓ Solana
👛 Wallet W1

💸 You pay: <b>0.5 SOL</b>
🍌 Bot fee (0.5%): 0.0025 SOL
🎯 Est. received: <b>16,976,243.54 Bonk</b>
🛡️ Min. received (5% slippage): 16,127,431.36 Bonk
📉 Price impact: 0.03%
🥷 MEV protection: Jito

⏳ Quote valid for 2 minutes. Network fee / Jito tip is paid separately.`,
  sending: '⚡ Sending buy…',
  submitted: '🚀 <b>Submitted</b> — <u>5VfY…xB1cD</u>\n⏳ Confirming…',
  done: '✅ <b>Bought $Bonk!</b> • ⛓ Solana\n\nSpent 0.5 SOL\n🔗 <u>View transaction</u>',
};
const KEYBOARDS = {
  card: $('#demo-kb')?.innerHTML,
  confirm: '<div><span id="demo-confirm">⚡ Confirm</span><span>❌ Cancel</span></div>',
  none: '',
  done: '<div><span>🍌 Open Token</span><span>📊 Positions</span><span>🏠 Menu</span></div>',
};

function heroReplay(gsap) {
  const text = $('#demo-text');
  const kb = $('#demo-kb');
  const paste = $('#demo-paste');
  const card = $('#demo-card');
  const replay = $('#demo-replay');
  if (!text) return;

  const show = (screen, keys) => () => { text.innerHTML = SCREENS[screen]; kb.innerHTML = KEYBOARDS[keys]; };
  const press = (id) => () => document.getElementById(id)?.classList.add('pressed');

  const tl = gsap.timeline({ paused: true, defaults: { ease: 'expo.out' }, onComplete: () => { replay.hidden = false; } });
  tl.call(() => { replay.hidden = true; })
    .call(show('card', 'card'))
    .fromTo(paste, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.6 }, 0.3)
    .fromTo(card, { y: 20, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.7 }, 1.0)
    .call(press('demo-buy'), null, 2.6)
    .call(show('confirm', 'confirm'), null, 3.1)
    .fromTo(text, { autoAlpha: 0.4 }, { autoAlpha: 1, duration: 0.5 }, 3.1)
    .call(press('demo-confirm'), null, 5.0)
    .call(show('sending', 'none'), null, 5.4)
    .call(show('submitted', 'none'), null, 6.1)
    .call(show('done', 'done'), null, 7.3)
    .fromTo(card, { scale: 0.97 }, { scale: 1, duration: 0.6, transformOrigin: 'left bottom' }, 7.3)
    // The mascot hops once when the trade lands
    .to('.mascot', { y: -14, duration: 0.22, ease: 'power2.out', yoyo: true, repeat: 1 }, 7.35);

  replay.addEventListener('click', () => tl.restart());

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { tl.play(0); io.disconnect(); }
  }, { threshold: 0.4 });
  io.observe(card);
}

// The CSS entrance holds the mascot's transform; hand it over to GSAP once it has played
function releaseMascot() {
  const mascot = $('.mascot');
  if (!mascot) return;
  mascot.addEventListener('animationend', () => {
    mascot.style.animation = 'none';
    mascot.style.opacity = '1';
    mascot.style.transform = 'none';
  }, { once: true });
}

// ---------------------------------------------------------------- masked heading lines
function splitLines(el) {
  const text = el.textContent.trim().replace(/\s+/g, ' ');
  el.dataset.text = text;
  el.textContent = '';
  const words = text.split(' ').map((word) => {
    const s = document.createElement('span');
    s.style.display = 'inline-block';
    s.textContent = word;
    el.append(s, ' ');
    return s;
  });
  const lines = [];
  for (const w of words) {
    const last = lines.at(-1);
    if (last && Math.abs(last.top - w.offsetTop) < 4) last.words.push(w.textContent);
    else lines.push({ top: w.offsetTop, words: [w.textContent] });
  }
  el.textContent = '';
  return lines.map((line) => {
    const mask = document.createElement('span');
    const inner = document.createElement('span');
    mask.className = 'line';
    inner.textContent = line.words.join(' ');
    mask.append(inner);
    el.append(mask, ' ');
    return inner;
  });
}

function headingLines(gsap, el) {
  const inners = splitLines(el);
  gsap.from(inners, {
    yPercent: 110, duration: 0.9, ease: 'expo.out', stagger: 0.09,
    scrollTrigger: { trigger: el, start: 'top 88%', once: true },
    // Give the plain text back so it rewraps normally on resize
    onComplete: () => { el.textContent = el.dataset.text; },
  });
}

// ---------------------------------------------------------------- rows arriving, per section
function rows(gsap, ScrollTrigger, selector, from) {
  const items = $$(selector);
  if (!items.length) return;
  gsap.set(items, { autoAlpha: 0, ...from });
  ScrollTrigger.batch(items, {
    start: 'top 90%',
    once: true,
    onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, x: 0, y: 0, duration: 0.7, ease: 'power3.out', stagger: 0.07, overwrite: true }),
  });
}

// ---------------------------------------------------------------- boot
function boot() {
  const { gsap, ScrollTrigger } = window;
  proLinks();
  bar();
  setupCalculator(gsap);
  if (!gsap || !ScrollTrigger) return; // static page is complete without the libraries
  gsap.registerPlugin(ScrollTrigger);

  const mm = gsap.matchMedia();
  mm.add({ motion: '(prefers-reduced-motion: no-preference)' }, (ctx) => {
    const { motion } = ctx.conditions;
    if (!motion) return;

    releaseMascot();
    heroReplay(gsap);

    // Created top to bottom so pin spacing is measured in page order
    // Hero recedes as you leave it (linear, small travel). The mascot stays planted on the hero's edge.
    gsap.timeline({ scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } })
      .to('.phone', { yPercent: -4, scale: 0.97, ease: 'none' }, 0)
      .to('.hero-copy', { yPercent: 8, ease: 'none' }, 0);

    // Lines are measured after the web font has loaded, or the breaks would be wrong
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    fontsReady.then(ctx.add(() => {
      $$('[data-lines]').forEach((el) => headingLines(gsap, el));
      ScrollTrigger.sort();
      ScrollTrigger.refresh();
    }));
    // Reading progress: a gold hairline under the sticky bar
    gsap.to('.progress', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: 0.3 } });

    // Dark sections open up from an inset, rounded panel to full bleed as they scroll in
    $$('.edge, .share').forEach((sec) => {
      const inset = () => (window.innerWidth < 700 ? 10 : 28);
      gsap.fromTo(sec,
        { clipPath: () => `inset(0px ${inset()}px 0px ${inset()}px round ${inset()}px)` },
        { clipPath: 'inset(0px 0px 0px 0px round 0px)', ease: 'none',
          scrollTrigger: { trigger: sec, start: 'top bottom', end: 'top 30%', scrub: true, invalidateOnRefresh: true } });
    });

    // Why ApeX: each claim lights up as it reaches the middle of the screen, its proof follows
    $$('.edge-list li').forEach((li) => {
      const st = { trigger: li, start: 'top 85%', end: 'top 50%', scrub: true };
      gsap.fromTo(li.querySelector('h3'), { color: '#5F5B51' }, { color: '#F4F0E7', ease: 'none', scrollTrigger: st });
      gsap.fromTo(li.querySelector('p'), { autoAlpha: 0.25 }, { autoAlpha: 1, ease: 'none', scrollTrigger: { ...st } });
    });
    rows(gsap, ScrollTrigger, '.edge-head p, .edge-cta', { y: 20 });

    rows(gsap, ScrollTrigger, '.steps li', { y: 24 });
    rows(gsap, ScrollTrigger, '.commands-intro p', { y: 20 });
    rows(gsap, ScrollTrigger, '.cmd-list > div', { x: -24 });
    $$('.share-head p, .split-note').forEach((p) => gsap.from(p, { autoAlpha: 0, y: 20, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: p, start: 'top 90%', once: true } }));
    // The banana stays still; only its legend text arrives
    rows(gsap, ScrollTrigger, '.legend p', { y: 20 });
    rows(gsap, ScrollTrigger, '.calc', { y: 32 });
    rows(gsap, ScrollTrigger, '.fees tbody tr', { y: 16 });
    rows(gsap, ScrollTrigger, '.facts li', { x: 24 });
    rows(gsap, ScrollTrigger, '.qa details', { y: 20 });

    // The name rises into the footer with the scroll
    gsap.from('.foot-name', { yPercent: 40, ease: 'none', scrollTrigger: { trigger: '.foot', start: 'top bottom', end: 'top 40%', scrub: true } });
  });

  ScrollTrigger.sort();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// Candlestick + volume chart (TradingView Lightweight Charts v5, loaded from jsDelivr in index.html)

const COLORS = { bg: '#171714', text: '#9A958A', grid: '#22221E', line: '#2A2A25', up: '#3DD68C', down: '#F0616D' };

// Enough decimals for memecoin prices (0.000003075 needs 9)
function precisionFor(price) {
  if (!(price > 0)) return 4;
  if (price >= 1) return 4;
  return Math.min(12, Math.max(4, 3 - Math.floor(Math.log10(price))));
}

export function createPriceChart(el) {
  const LWC = window.LightweightCharts;
  if (!LWC) {
    el.textContent = 'The chart library did not load. Check your connection and reload.';
    return null;
  }
  const chart = LWC.createChart(el, {
    autoSize: true,
    layout: { background: { color: COLORS.bg }, textColor: COLORS.text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11 },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderColor: COLORS.line },
    // Capped bar spacing: a new token with a dozen candles would otherwise stretch them into wide bars
    timeScale: { borderColor: COLORS.line, timeVisible: true, secondsVisible: false, barSpacing: 8, minBarSpacing: 1, maxBarSpacing: 14, rightOffset: 4 },
    crosshair: { mode: 0 },
  });
  const candles = chart.addSeries(LWC.CandlestickSeries, {
    upColor: COLORS.up,
    downColor: COLORS.down,
    wickUpColor: COLORS.up,
    wickDownColor: COLORS.down,
    borderVisible: false,
  });
  const volume = chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' });
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  let first = true;
  return {
    set(rows) {
      if (!rows.length) return;
      const precision = precisionFor(rows.at(-1).close);
      candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
      candles.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      volume.setData(rows.map((r) => ({ time: r.time, value: r.volume, color: r.close >= r.open ? 'rgba(61,214,140,0.35)' : 'rgba(240,97,109,0.35)' })));
      if (first) chart.timeScale().fitContent();
      first = false;
    },
    reset() {
      first = true;
    },
    destroy() {
      chart.remove();
    },
  };
}

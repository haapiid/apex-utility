import { loadFont as loadArchivo } from '@remotion/google-fonts/Archivo';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

// Brand palette from assets/mascot/DESIGN_GUIDE.md: one ground (ivory / black), one ink, one accent (yellow)
export const C = {
  ivory: '#F4F0E7',
  paper: '#FBF9F4',
  ink: '#171714',
  ink2: '#26261F',
  muted: '#9A958A',
  yellow: '#F2C94C',
  yellow2: '#F7DC86',
  up: '#3DD68C',
  tgBg: '#CFDCC2',
};

export const { fontFamily: FONT } = loadArchivo('normal', { weights: ['500', '700', '900'], subsets: ['latin'] });
export const { fontFamily: MONO } = loadMono('normal', { weights: ['500', '700'], subsets: ['latin'] });

export const CHAINS = ['Solana', 'Ethereum', 'BSC', 'Base', 'HyperEVM', 'MegaETH', 'Robinhood'];
export const BOT = '@apex_utility_chain_bot';
export const SITE = 'apexutility.fun';

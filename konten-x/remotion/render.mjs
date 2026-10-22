// Renders every X asset into konten-x/: node render.mjs [logo|banner|gif|demo]
import { execSync } from 'node:child_process';

const out = (name) => `../${name}`;
const jobs = {
  logo: `npx remotion still src/index.jsx LogoX ${out('logo-x-400.png')}`,
  banner: `npx remotion still src/index.jsx BannerX ${out('banner-x-1500x500.png')}`,
  // X keeps GIFs under 15 MB: every 2nd frame and 60% scale (648×648, 10 fps)
  gif: `npx remotion render src/index.jsx PostGif ${out('post-x.gif')} --codec=gif --every-nth-frame=2 --scale=0.6`,
  demo: `npx remotion render src/index.jsx Demo ${out('demo-x-1080p.mp4')} --codec=h264 --crf=20`,
};

const pick = process.argv.slice(2);
for (const [name, cmd] of Object.entries(jobs)) {
  if (pick.length && !pick.includes(name)) continue;
  console.log(`\n▶ ${name}: ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

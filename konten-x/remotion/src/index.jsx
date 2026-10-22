import React from 'react';
import { registerRoot, Composition, Still } from 'remotion';
import { LogoX, BannerX } from './stills';
import { PostGif, GIF_FPS, GIF_FRAMES } from './PostGif';
import { Demo, DEMO_FPS, DEMO_FRAMES } from './Demo';

function Root() {
  return (
    <>
      <Still id="LogoX" component={LogoX} width={400} height={400} />
      <Still id="BannerX" component={BannerX} width={1500} height={500} />
      <Composition id="PostGif" component={PostGif} width={1080} height={1080} fps={GIF_FPS} durationInFrames={GIF_FRAMES} />
      <Composition id="Demo" component={Demo} width={1920} height={1080} fps={DEMO_FPS} durationInFrames={DEMO_FRAMES} />
    </>
  );
}

registerRoot(Root);

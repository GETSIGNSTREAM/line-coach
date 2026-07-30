'use client';

import { useState, useEffect } from 'react';

// Viewport width, for the one layout decision CSS can't make: how far
// to shrink the FIXED PIXEL chrome inside an order card. Everything else
// responsive — the grid breakpoints, dvh fallbacks, safe-area padding,
// the portrait prompt — lives in the stylesheet in app/layout.js, which
// is the right tool and needs no JS.
//
// SSR/hydration: returns the wall-display default on the server and on
// the first client render, then resolves post-mount. Same discipline as
// the touch and language detection in LineCoachDisplay. That costs one
// frame of desktop layout on load, which is irrelevant on a kiosk that
// boots once a day.

const WALL = { w: 1920, h: 1080 };

export default function useViewport() {
  const [size, setSize] = useState(WALL);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame = null;
    const read = () => {
      frame = null;
      setSize({ w: window.innerWidth, h: window.innerHeight });
    };
    // rAF-coalesced: an iPad rotation fires a burst of resize events,
    // and re-rendering a 5,500-line board on each one is wasteful.
    const onResize = () => {
      if (frame == null) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  const { w } = size;

  return {
    w,
    // Multiplier for the fixed pixel chrome inside a card — the item
    // sidebar, food photo, and side rail together eat ~400px before any
    // text gets a pixel. On a 1024px iPad with a 320px rail that leaves
    // ~300px for an entree name set at 1.95rem, which wraps three lines.
    //
    // Deliberately one factor rather than more `isComfortable` ternaries
    // across the seven call sites: there is a single number to tune when
    // this meets real hardware. Text sizes are NOT scaled — they're
    // clamp()-based or deliberately large for distance reading, and
    // shrinking them defeats the purpose of the display.
    //
    // 1.0 at wall-screen widths, so the deployed kiosks are unaffected.
    chromeScale: w >= 1400 ? 1 : w >= 1200 ? 0.9 : w >= 1000 ? 0.82 : 0.72,
  };
}

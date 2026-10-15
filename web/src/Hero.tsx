// img-fx hero (three.js), lazy-loaded so the shader only ships when a hero is on screen.
import { useEffect, useRef, useState } from 'react';
import { ImageGeneration, type ImageGenerationHandle } from 'img-fx';
import { coverJpeg } from './brand';
import { Icon } from './icons';

export default function Hero({ seed, preset = 'pixels-organic', auto = false, count = 3 }: {
  seed: string; preset?: 'pixels-organic' | 'pixels-mechanic' | 'sweep-gradient'; auto?: boolean; count?: number;
}) {
  const ref = useRef<ImageGenerationHandle>(null);
  const [imgs, setImgs] = useState<string[]>([]);
  useEffect(() => {
    let off = false;
    Promise.all(Array.from({ length: count }, (_, i) => coverJpeg(`${seed}#${i}`))).then((a) => { if (!off) setImgs(a); }).catch(() => {});
    return () => { off = true; };
  }, [seed, count]);
  // Without the auto loop the cover is « generated » once, then stays.
  useEffect(() => {
    if (auto || !imgs.length) return;
    const t = setTimeout(() => ref.current?.triggerReveal({ hold: 'manual' }), 1100);
    return () => clearTimeout(t);
  }, [imgs, auto]);
  if (!imgs.length) return <div className="stage" style={{ width: '100%', height: '100%' }} />;
  return (
    <>
      <ImageGeneration ref={ref} preset={preset} images={imgs} autoReveal={auto} revealHoldMs={3200} theme="dark" cardBg="#131313">
        <div style={{ width: '100%', height: '100%', borderRadius: 18 }} />
      </ImageGeneration>
      {!auto && (
        <button className="chip icon" title="Régénérer la couverture" aria-label="Régénérer la couverture"
          style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,.45)', backdropFilter: 'blur(8px)' }}
          onClick={() => (ref.current?.isImageActive() ? ref.current.triggerRegenerate({ durationMs: 2600 }) : ref.current?.triggerReveal({ hold: 'manual' }))}>
          <Icon name="refresh" size={15} />
        </button>
      )}
    </>
  );
}

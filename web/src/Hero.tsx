// img-fx hero (three.js), lazy-loaded so the shader only ships when a hero is on screen.
import { useEffect, useRef, useState } from 'react';
import { ImageGeneration, type ImageGenerationHandle } from 'img-fx';
import { coverJpeg, coverUrl } from './brand';
import { Icon } from './icons';
import { FxBoundary, hasWebGL } from './ui';

type Props = { seed: string; preset?: 'pixels-organic' | 'pixels-mechanic' | 'sweep-gradient'; auto?: boolean; count?: number };

/** img-fx needs WebGL and throws without it: the static cover takes its place, and the rest of the UI is unaffected. */
export default function Hero(props: Props) {
  const cover = <Cover seed={props.seed} />;
  return hasWebGL() ? <FxBoundary fallback={cover}><Shader {...props} /></FxBoundary> : cover;
}

/** The same procedural cover the shader reveals, as a plain image. */
function Cover({ seed }: { seed: string }) {
  return <img src={coverUrl(`${seed}#0`, 768)} alt="" style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 18 }} />;
}

function Shader({ seed, preset = 'pixels-organic', auto = false, count = 3 }: Props) {
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

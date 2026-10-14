// Brand assets built for AvityOne in the libraries.dev style: logo mark, generative project covers,
// and the agent identity system (bot-avatars looks + thinking-orbs states).
import { lazy, Suspense } from 'react';
import { BotAvatar, type BotAvatarProps } from 'bot-avatars';
import type { OrbState } from 'thinking-orbs';
import { Boundary, webgl } from './ui';

const Hero = lazy(() => import('./Hero'));

export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="lm-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9cc5ff" /><stop offset="1" stopColor="#0071fc" /></linearGradient>
        <linearGradient id="lm-b" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d9ccff" /><stop offset="1" stopColor="#6d5dfc" /></linearGradient>
      </defs>
      <path d="M12 2.5 21 11.5 12 20.5 3 11.5Z" fill="url(#lm-a)" />
      <path d="M12 7.3 16.2 11.5 12 15.7 7.8 11.5Z" fill="url(#lm-b)" />
      <path d="M12 2.5 21 11.5 12 20.5 3 11.5Z" fill="none" stroke="#fff" strokeOpacity=".25" strokeWidth=".6" />
    </svg>
  );
}

// ---------- generative covers ----------

function prng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const PALETTES = [
  ['#0071fc', '#7db4ff', '#6d5dfc', '#00d1ff'], // azur
  ['#6d5dfc', '#c4b5fd', '#ff5cc8', '#0071fc'], // violet
  ['#00c2a8', '#5eead4', '#0071fc', '#a3e635'], // lagon
  ['#ff7a1a', '#ffd166', '#ff4d6d', '#6d5dfc'], // braise
  ['#ff4d9d', '#ffb3d9', '#7c5cff', '#00d1ff'], // bonbon
];

/** A dark, glowing abstract cover unique to `seed`: blurred colour fields, a glass orb, a dot grid and film grain. */
export function coverSvg(seed: string, size = 768): string {
  const r = prng(seed);
  const pal = PALETTES[Math.floor(r() * PALETTES.length)];
  const blobs = Array.from({ length: 5 }, (_, i) =>
    `<ellipse cx="${(10 + r() * 80).toFixed(1)}" cy="${(10 + r() * 80).toFixed(1)}" rx="${(18 + r() * 22).toFixed(1)}" ry="${(14 + r() * 20).toFixed(1)}" fill="${pal[i % pal.length]}" opacity="${(0.45 + r() * 0.4).toFixed(2)}"/>`).join('');
  const ox = 32 + r() * 36, oy = 34 + r() * 30, or = 14 + r() * 9;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">
<defs>
<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="11"/></filter>
<filter id="g"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 .09 0"/></filter>
<radialGradient id="o" cx=".36" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".22" stop-color="${pal[1]}" stop-opacity=".75"/><stop offset=".7" stop-color="${pal[0]}" stop-opacity=".35"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>
<radialGradient id="v" cx=".5" cy=".5" r=".75"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></radialGradient>
<pattern id="d" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".28" fill="#fff" opacity=".16"/></pattern>
</defs>
<rect width="100" height="100" fill="#0e0e10"/>
<g filter="url(#b)">${blobs}</g>
<rect width="100" height="100" fill="url(#d)"/>
<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="${or.toFixed(1)}" fill="url(#o)"/>
<circle cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="${or.toFixed(1)}" fill="none" stroke="#fff" stroke-opacity=".18" stroke-width=".25"/>
<rect width="100" height="100" fill="url(#v)"/>
<rect width="100" height="100" filter="url(#g)"/>
</svg>`;
}

export const coverUrl = (seed: string, size = 256) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(coverSvg(seed, size));

const rasters = new Map<string, Promise<string>>();
/** Raster (JPEG data URL) of a cover — what the img-fx shader samples as a texture. */
export function coverJpeg(seed: string, size = 768): Promise<string> {
  const key = `${seed}@${size}`;
  if (!rasters.has(key)) {
    rasters.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d')!.drawImage(img, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = () => reject(new Error('cover'));
      img.src = coverUrl(seed, size);
    }));
  }
  return rasters.get(key)!;
}

/** A project cover: revealed by the img-fx shader where WebGL runs well, else the still image the shader would show. */
export function Cover({ seed, auto, count }: { seed: string; auto?: boolean; count?: number }) {
  const still = <img className="cover-still" src={coverUrl(`${seed}#0`, 768)} alt="" />;
  if (!webgl()) return still;
  return <Boundary fallback={still}><Suspense fallback={null}><Hero seed={seed} auto={auto} count={count} /></Suspense></Boundary>;
}

// ---------- agent identities ----------

type Look = Pick<BotAvatarProps, 'type' | 'color' | 'glasses' | 'headphones' | 'hat' | 'bowTie'> & { tint: string };

export const LOOKS: Record<string, Look> = {
  claude: { type: 'cat', glasses: 'round', tint: '#f4a46a' },        // le penseur
  codex: { type: 'drop', headphones: true, tint: '#4fd1c5' },        // le codeur concentré
  cursor: { type: 'square', glasses: 'shades', tint: '#7db4ff' },    // le rapide
  opencode: { type: 'circle', hat: 'beanie', tint: '#b9a7ff' },      // l'explorateur
  avity: { type: 'droid', bowTie: true, tint: '#d4d7de' },           // l'orchestrateur
};
const SPARE: Look[] = [
  { type: 'clover', tint: '#8ec5ff' }, { type: 'flower', tint: '#7ee08a' }, { type: 'star', tint: '#ffd166' },
  { type: 'alien', tint: '#c5f05a' }, { type: 'hexagon', tint: '#ff8a6b' }, { type: 'pill', tint: '#8f8cff' },
];
export const look = (id?: string | null): Look => {
  if (id && LOOKS[id]) return LOOKS[id];
  let h = 0;
  for (const c of id ?? '') h = (h * 31 + c.charCodeAt(0)) | 0;
  return SPARE[Math.abs(h) % SPARE.length];
};

export type AvatarState = 'default' | 'working' | 'sleeping';

export function AgentAvatar({ id, size = 28, state = 'default', paused, interactive, className }: {
  id?: string | null; size?: number; state?: AvatarState; paused?: boolean; interactive?: boolean; className?: string;
}) {
  const l = look(id);
  // Accessories read as noise below ~26px; the plush fur only pays off at hero sizes.
  const wear = size >= 26 ? { glasses: l.glasses, headphones: l.headphones, hat: l.hat, bowTie: l.bowTie } : {};
  return (
    <BotAvatar type={l.type} color={l.color} size={size} state={state} paused={paused} theme="dark" className={className}
      interactive={interactive ?? size >= 40} shading={size >= 56 ? 'fabric' : 'plastic'} face={size >= 40 ? 'mouth' : undefined}
      aria-label={`${id ?? 'agent'}${state === 'working' ? ', au travail' : state === 'sleeping' ? ', en veille' : ''}`} {...wear} />
  );
}

/** What the agent is doing → which thinking orb animates it. */
export const ORB_FOR_KIND: Record<string, OrbState> = {
  read: 'searching', search: 'searching', edit: 'shaping', delete: 'shaping', move: 'shaping',
  execute: 'working', think: 'solving', fetch: 'connecting', switch_mode: 'breathing', other: 'working',
};

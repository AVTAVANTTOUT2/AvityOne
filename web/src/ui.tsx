// Shared primitives: markdown, diff, liquid segmented control, liquid plus-menu, popover, toasts.
import { Component, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Liquid } from 'liquid-gooey';
import { Icon, type IconName } from './icons';

DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
});

/** Agent output is untrusted (prompt injection can reach it): always sanitized. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? '', { async: false, gfm: true }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** Line diff via LCS, unchanged runs folded to 3 lines of context. */
export function Diff({ path, oldText, newText }: { path: string; oldText?: string; newText?: string }) {
  const { lines, add, del } = useMemo(() => {
    const A = oldText ? oldText.split('\n') : [], B = (newText ?? '').split('\n');
    let ops: [string, string][];
    if (A.length * B.length > 250_000) ops = [...A.map((l): [string, string] => ['-', l]), ...B.map((l): [string, string] => ['+', l])];
    else {
      const n = A.length, m = B.length, T = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
      ops = [];
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) ops.push(['-', A[i++]]); else ops.push(['+', B[j++]]);
      }
      while (i < n) ops.push(['-', A[i++]]);
      while (j < m) ops.push(['+', B[j++]]);
    }
    const near = ops.map((_, k) => ops.slice(Math.max(0, k - 3), k + 4).some((o) => o[0] !== ' '));
    const lines: { cls: string; text: string }[] = [];
    ops.forEach((o, k) => {
      if (near[k]) lines.push({ cls: o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : '', text: `${o[0]} ${o[1]}` });
      else if (near[k - 1]) lines.push({ cls: 'gap', text: '  ⋯' });
    });
    return { lines, add: ops.filter((o) => o[0] === '+').length, del: ops.filter((o) => o[0] === '-').length };
  }, [oldText, newText]);
  return (
    <div className="diff">
      <div className="diff-head"><Icon name="file" size={14} /><span className="grow ellipsis">{path}</span><span className="num-add">+{add}</span><span className="num-del">−{del}</span></div>
      <div className="diff-body">{lines.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)}</div>
    </div>
  );
}

/** Segmented control whose thumb is a liquid drop that trails between options (liquid-gooey « move »). */
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [box, setBox] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const b = refs.current[options.findIndex((o) => o.value === value)];
      if (b) setBox({ x: b.offsetLeft, w: b.offsetWidth });
    };
    measure();
    document.fonts?.ready.then(measure);
  }, [value, options]);
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      <Liquid fill="#3b3b3b" blur={5} contrast={16} shadow="0 1px 2px rgba(0,0,0,.35)" style={{ position: 'absolute', inset: 0 }}>
        <Liquid.Item effect="move" move={{ springiness: 0.55, trail: 0.45 }} radius={15}>
          <div className="seg-thumb" style={{ width: box.w, transform: `translateX(${box.x}px)` }} />
        </Liquid.Item>
      </Liquid>
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => { refs.current[i] = el; }} role="radio" aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export type DropAction = { icon: IconName; label: string; on?: boolean; disabled?: boolean; onClick: () => void };

/** A « + » that splits into liquid droplets (liquid-gooey « morph »), one per action. */
export function PlusMenu({ actions }: { actions: DropAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, open, () => setOpen(false));
  const step = 34;
  return (
    <div ref={ref} className="plus-wrap" style={{ width: open ? 30 + actions.length * step : 30, transition: 'width 380ms var(--ease)' }}>
      <Liquid fill="#2e2e2e" blur={6} contrast={18} shadow="0 2px 6px rgba(0,0,0,.35)" style={{ position: 'absolute', inset: 0 }}>
        {actions.map((a, i) => (
          <Liquid.Item key={a.label} className="plus-drop" x={open ? (i + 1) * step : 0} transition="bouncy" delay={open ? i * 40 : 0} radius={15}>
            <button className={`drop-btn ${a.on ? 'on' : ''}`} title={a.label} aria-label={a.label} tabIndex={open ? 0 : -1}
              disabled={a.disabled} onClick={() => { a.onClick(); }}><Icon name={a.icon} size={15} /></button>
          </Liquid.Item>
        ))}
        <Liquid.Item className="plus-drop" radius={15}>
          <button className="drop-btn" aria-expanded={open} aria-label="Actions" title="Actions" onClick={() => setOpen((o) => !o)}>
            <Icon name="plus" size={16} style={{ transform: open ? 'rotate(45deg)' : 'none', transition: 'transform 300ms var(--ease)' }} />
          </button>
        </Liquid.Item>
      </Liquid>
    </div>
  );
}

export function useOutside(ref: RefObject<HTMLElement | null>, active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [active, close, ref]);
}

/** Trigger + floating menu, closed on outside click / Escape. */
export function Popover({ trigger, children, down }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; down?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  useOutside(ref, open, close);
  return (
    <div className="menu-anchor" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && <div className={`menu ${down ? 'down' : ''}`} role="menu">{children(close)}</div>}
    </div>
  );
}

export const toast = (msg: string, bad = false) => window.dispatchEvent(new CustomEvent('avity:toast', { detail: { msg, bad } }));

export function Toaster() {
  const [t, setT] = useState<{ msg: string; bad: boolean } | null>(null);
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => { setT((e as CustomEvent).detail); clearTimeout(timer); timer = window.setTimeout(() => setT(null), 4200); };
    window.addEventListener('avity:toast', on);
    return () => window.removeEventListener('avity:toast', on);
  }, []);
  return t ? <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">{t.msg}</div> : null;
}

/** Wraps an async action so failures surface as a toast instead of an unhandled rejection. */
export const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
  try { await fn(...a); } catch (e) { toast((e as Error).message, true); }
};

let webgl: boolean | null = null;
/** Whether this browser can create a WebGL context (GPU disabled or blocklisted, locked-down browsers… can't). */
export function hasWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
    webgl = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // browsers cap live contexts: give the probe's back
  } catch { webgl = false; }
  return webgl;
}

/** Shows `fallback` instead of a decorative effect that crashed, so the effect can never take the whole UI down. */
export class FxBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.warn('effet visuel désactivé :', e); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/**
 * metal-fx keeps its host invisible until the first WebGL frame lands. If that never happens (context lost,
 * GPU blocklisted…), fall back to the plain element so a primary control can never vanish. Without WebGL at all,
 * metal-fx isn't mounted: its own fallback leaves MetalText's rim canvas stranded in the page's top-left corner.
 */
export function MetalSafe({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const [ok, setOk] = useState(hasWebGL);
  useEffect(() => {
    if (!ok) return;
    let tries = 0;
    const i = setInterval(() => {
      if (document.hidden) return;
      const root = wrap.current?.querySelector<HTMLElement>('.metal-fx-root');
      if (!root || root.style.visibility !== 'hidden') return clearInterval(i);
      if (++tries >= 3) { clearInterval(i); setOk(false); }
    }, 1000);
    return () => clearInterval(i);
  }, []);
  return ok ? <span ref={wrap} style={{ display: 'contents' }}>{children}</span> : <>{fallback}</>;
}

// Shared primitives: markdown, diff, liquid segmented control, liquid plus-menu, popover, toasts, error boundary.
import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Liquid } from 'liquid-gooey';
import { Icon, type IconName } from './icons';

DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
});

const COPY = '<button type="button" class="copy" title="Copier" aria-label="Copier le code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9.5A1.5 1.5 0 0 1 10.5 8h7A1.5 1.5 0 0 1 19 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 9 18.5ZM15 8V5.5A1.5 1.5 0 0 0 13.5 4h-7A1.5 1.5 0 0 0 5 5.5v9A1.5 1.5 0 0 0 6.5 16H9"/></svg></button>';

/** Clipboard API where the page is a secure context, else the legacy copy command (plain http on a LAN or Tailscale IP). */
export async function copyText(text: string) {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copie refusée par le navigateur');
}

/** Agent output is untrusted (prompt injection can reach it): always sanitized. Our copy button is added after sanitizing. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? '', { async: false, gfm: true }) as string).replaceAll('<pre>', `<pre>${COPY}`), [text]);
  const copy = (e: MouseEvent) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button.copy');
    const code = b?.parentElement?.querySelector('code') ?? b?.parentElement;
    if (!b || !code) return;
    copyText(code.textContent ?? '').then(() => {
      b.classList.add('done');
      setTimeout(() => b.classList.remove('done'), 1200);
    }, (err) => toast(err.message, true));
  };
  return <div className="md" onClick={copy} dangerouslySetInnerHTML={{ __html: html }} />;
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
  useOutside([ref], open, () => setOpen(false));
  const step = 34;
  return (
    <div ref={ref} className="plus-wrap" style={{ width: open ? 30 + actions.length * step : 30, transition: 'width 380ms var(--ease)' }}>
      <Liquid fill="#2e2e2e" blur={6} contrast={18} shadow="0 2px 6px rgba(0,0,0,.35)" style={{ position: 'absolute', inset: 0 }}>
        {actions.map((a, i) => (
          <Liquid.Item key={a.label} className="plus-drop" x={open ? (i + 1) * step : 0} transition="bouncy" delay={open ? i * 40 : 0} radius={15}>
            <button className={`drop-btn ${a.on ? 'on' : ''}`} title={a.label} aria-label={a.label} aria-hidden={!open} tabIndex={open ? 0 : -1}
              disabled={!open || a.disabled} onClick={() => { a.onClick(); }}><Icon name={a.icon} size={15} /></button>
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

/** Calls `close` on a pointer down outside every ref'd element, or on Escape. */
export function useOutside(refs: RefObject<HTMLElement | null>[], active: boolean, close: (how: 'outside' | 'escape') => void) {
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent) => { if (!refs.some((r) => r.current?.contains(e.target as Node))) close('outside'); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close('escape'); };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [active, close, refs]);
}

/**
 * Trigger + floating menu, closed on outside click / Escape. The menu is portalled to <body> with fixed coordinates:
 * the composer's glow clips its content (`overflow: hidden`), which used to cut the agent menu down to one row.
 */
export function Popover({ trigger, children, down }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; down?: boolean }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<CSSProperties>({});
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [anchor, menu], []);
  const close = useCallback((how?: 'outside' | 'escape') => {
    setOpen(false);
    if (how === 'escape') anchor.current?.querySelector('button')?.focus();
  }, []);
  useOutside(refs, open, close);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      setAt(down ? { top: r.bottom + 8, right: Math.max(8, innerWidth - r.right) } : { bottom: innerHeight - r.top + 8, left: Math.max(8, r.left) });
    };
    place();
    menu.current?.querySelector<HTMLElement>('button:not(:disabled), select')?.focus({ preventScroll: true });
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [open, down]);
  return (
    <div className="menu-anchor" ref={anchor}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && createPortal(<div ref={menu} className={`menu ${down ? 'down' : ''}`} role="menu" style={at}>{children(() => close())}</div>, document.body)}
    </div>
  );
}

export type ToastAction = { label: string; onClick: () => void };
type Toast = { msg: string; bad: boolean; action?: ToastAction };

export const toast = (msg: string, bad = false, action?: ToastAction) => window.dispatchEvent(new CustomEvent('avity:toast', { detail: { msg, bad, action } }));

export function Toaster() {
  const [t, setT] = useState<Toast | null>(null);
  useEffect(() => {
    let timer = 0;
    const on = (e: Event) => {
      const next: Toast = (e as CustomEvent).detail;
      setT(next);
      clearTimeout(timer);
      timer = window.setTimeout(() => setT(null), next.action ? 7000 : 4200);
    };
    window.addEventListener('avity:toast', on);
    return () => window.removeEventListener('avity:toast', on);
  }, []);
  return t ? createPortal(
    <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">
      {t.msg}
      {t.action && <button className="toast-act" onClick={() => { setT(null); t.action!.onClick(); }}>{t.action.label}</button>}
    </div>, [...document.querySelectorAll('dialog[open]')].at(-1) ?? document.body
  ) : null;
}

/** Wraps an async action so failures surface as a toast instead of an unhandled rejection. */
export const guard = <A extends unknown[]>(fn: (...a: A) => Promise<unknown> | unknown) => async (...a: A) => {
  try { await fn(...a); } catch (e) { toast((e as Error).message, true); }
};

/** Keeps a crashing subtree (refused WebGL context, lost GPU…) to its own box instead of blanking the whole app. */
export class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.warn('[avity] affichage de secours :', e); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

let gl: boolean | undefined;
/**
 * Hardware WebGL is available. Software rendering counts as no: the shaders crawl there (well under 1 fps on the login
 * screen) and freeze the whole page. Browsers do not always flag it as a performance caveat, hence the renderer name.
 */
export const webgl = () => gl ??= (() => {
  try {
    const c = document.createElement('canvas');
    const x = c.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) ?? c.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!x) return false;
    const info = x.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(x.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : x.RENDERER));
    x.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch { return false; }
})();

/**
 * metal-fx keeps its host invisible until the first WebGL frame lands. If that never happens (context lost,
 * GPU blocklisted…), fall back to the plain element so a primary control can never vanish. Without hardware WebGL,
 * metal-fx isn't mounted at all: its own fallback leaves MetalText's rim canvas stranded in the page's top-left corner.
 */
export function MetalSafe({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const wrap = useRef<HTMLSpanElement>(null);
  const [ok, setOk] = useState(webgl);
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
  }, [ok]);
  return ok ? <Boundary fallback={fallback}><span ref={wrap} style={{ display: 'contents' }}>{children}</span></Boundary> : <>{fallback}</>;
}

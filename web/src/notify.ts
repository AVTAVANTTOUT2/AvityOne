// System notifications: opt-in per browser, and only where the browser allows them (HTTPS or localhost).
const KEY = 'avity.notify';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } };

export const canNotify = () => typeof Notification !== 'undefined' && window.isSecureContext;
export const notifyOn = () => canNotify() && Notification.permission === 'granted' && read() === '1';

/** Turns notifications on (asking the browser's permission the first time) or off. Resolves to the new state. */
export async function setNotify(on: boolean): Promise<boolean> {
  if (!on || !canNotify()) { write('0'); return false; }
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  write(perm === 'granted' ? '1' : '0');
  return perm === 'granted';
}

/** Shows a system notification if they are on. `tag` replaces an older one for the same session. */
export function systemNotify(title: string, body: string, tag: string, onClick: () => void): boolean {
  if (!notifyOn()) return false;
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.svg' });
    n.onclick = () => { n.close(); onClick(); };
    return true;
  } catch { return false; } // Android browsers only notify through a service worker (to come with the PWA)
}

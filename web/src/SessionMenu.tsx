// Session header controls: in-place rename and the « ⋯ » menu (pin, export, archive, delete).
import { useRef, useState } from 'react';
import type { SessionRow } from './api';
import { Icon } from './icons';
import { Popover } from './ui';

export type SessionActions = {
  rename: () => void;
  pin: (on: boolean) => void;
  archive: (on: boolean) => void;
  exportMd: () => void;
  remove: () => void;
};

/** Enter or blur saves, Escape cancels. An emptied title goes back to automatic naming. */
export function TitleInput({ value, onSave, onClose }: { value: string; onSave: (title: string) => void; onClose: () => void }) {
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onClose();
    if (title !== null && title.trim() !== value) onSave(title);
  };
  return (
    <input className="title-input" defaultValue={value} autoFocus maxLength={120} aria-label="Titre de la session"
      onFocus={(e) => e.currentTarget.select()} onBlur={(e) => finish(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        if (e.key === 'Escape') finish(null);
      }} />
  );
}

export function SessionMenu({ session, busy, act }: { session: SessionRow; busy: boolean; act: SessionActions }) {
  return (
    <Popover down trigger={(toggle, open) => (
      <button className={`chip icon ${open ? 'on' : ''}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label="Actions de la session" title="Actions de la session">
        <Icon name="more" size={16} strokeWidth={2.8} />
      </button>
    )}>
      {(close) => <Items session={session} busy={busy} act={act} close={close} />}
    </Popover>
  );
}

// Mounted only while the menu is open, so a half-confirmed delete resets when it closes.
function Items({ session, busy, act, close }: { session: SessionRow; busy: boolean; act: SessionActions; close: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const run = (fn: () => void) => () => { close(); fn(); };
  return (
    <>
      <button role="menuitem" onClick={run(act.rename)}><Icon name="edit" size={15} />Renommer</button>
      <button role="menuitem" onClick={run(() => act.pin(!session.pinned))} disabled={!!session.archived}>
        <Icon name="pin" size={15} />{session.pinned ? 'Désépingler' : 'Épingler'}
      </button>
      <button role="menuitem" onClick={run(act.exportMd)}><Icon name="download" size={15} />Exporter en Markdown</button>
      <button role="menuitem" onClick={run(() => act.archive(!session.archived))}>
        <Icon name="archive" size={15} />{session.archived ? 'Désarchiver' : 'Archiver'}
      </button>
      <button role="menuitem" className="danger" disabled={busy} onClick={confirm ? run(act.remove) : () => setConfirm(true)}>
        <Icon name="trash" size={15} />
        <span className="grow">{confirm ? 'Confirmer la suppression' : 'Supprimer'}
          {confirm && <span className="desc">Messages et sous-sessions effacés. La mémoire du projet reste.</span>}</span>
      </button>
    </>
  );
}

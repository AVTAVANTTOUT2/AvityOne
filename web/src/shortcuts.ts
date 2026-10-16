type SessionKey = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

export function sessionDirection(event: SessionKey, modalOpen: boolean): -1 | 0 | 1 {
  if (modalOpen || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return 0;
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
}

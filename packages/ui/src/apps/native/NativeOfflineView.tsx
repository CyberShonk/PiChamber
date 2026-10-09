import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { readOfflineCopies, clearOfflineCopies, type OfflineCopy } from './offlineCopies';
import { toast } from '@/components/ui';

export const NativeOfflineView = () => {
  const [copies, setCopies] = useState<OfflineCopy[] | null>(null);
  const [selected, setSelected] = useState<OfflineCopy | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    void readOfflineCopies().then((value) => { if (!disposed) setCopies(value); }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, []);
  return <div className="min-h-0 flex-1 overflow-auto p-4" data-no-drawer-swipe="true">
    <p className="mb-4 typography-small text-muted-foreground">Read-only copies of loaded messages. These are snapshots, not live sessions. Nothing here is sent to a host.</p>
    {error ? <p role="alert">Offline storage is unavailable.</p> : copies === null ? <p role="status">Loading copies…</p> : copies.length === 0 ? <p>No offline copies. Enable offline copies in Appearance, then save from Quick navigation.</p> : selected ? <>
      <Button size="sm" variant="outline" onClick={() => setSelected(null)}>Back to copies</Button>
      <h2 className="mt-4 typography-ui-label">{selected.title}</h2>
      <p className="typography-meta text-muted-foreground">{selected.host} · Saved {new Date(selected.savedAt).toLocaleString()}</p>
      <pre className="mt-4 whitespace-pre-wrap break-words font-mono text-[14px]">{selected.text}</pre>
    </> : copies.map((copy) => <button type="button" key={copy.id} className="flex min-h-14 w-full flex-col border-b border-border py-3 text-left" onClick={() => setSelected(copy)}>
      <span className="typography-ui-label">{copy.title}</span><span className="typography-meta text-muted-foreground">{copy.host} · {new Date(copy.savedAt).toLocaleString()}</span>
    </button>)}
    {copies && copies.length > 0 && <Button className="mt-4" variant="outline" size="sm" onClick={() => void clearOfflineCopies().then(() => { setCopies([]); setSelected(null); }).catch(() => toast.error('Offline copies could not be cleared.'))}>Clear offline copies</Button>}
  </div>;
};

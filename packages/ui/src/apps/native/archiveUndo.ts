import { toast } from '@/components/ui';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { mapWithConcurrency } from '@/lib/concurrency';
import { nativeHaptic } from './device';

/** Undo only IDs actually archived by this action. A host switch invalidates the undo target. */
export const showNativeArchiveUndo = (ids: readonly string[], runtimeKey: string, restore: (id: string) => Promise<boolean>): void => {
  if (ids.length === 0 || getRuntimeKey() !== runtimeKey) return;
  let used = false;
  toast.success(ids.length === 1 ? 'Session archived' : `Archived ${ids.length} sessions`, {
    duration: 6000,
    action: { label: 'Undo', onClick: () => {
      if (used) return;
      used = true;
      if (getRuntimeKey() !== runtimeKey) { toast.info('Switch back to the original host to restore these sessions.'); return; }
      void mapWithConcurrency([...ids], 4, async (id) => {
        if (getRuntimeKey() !== runtimeKey) return false;
        try { return await restore(id); } catch { return false; }
      }).then((results) => {
        const failed = results.filter((result) => !result).length;
        if (failed > 0) { nativeHaptic('error'); toast.error(failed === 1 ? 'One session could not be restored.' : `${failed} sessions could not be restored.`); }
        else nativeHaptic('success');
      });
    } },
  });
};

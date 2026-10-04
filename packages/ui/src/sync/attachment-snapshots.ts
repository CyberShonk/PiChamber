import type { AttachedFile } from '@/stores/types/sessionTypes';

/**
 * Clone an attachment for ownership handoff or recovery.
 *
 * File bytes are immutable and may remain shared. Mutable wrapper state is
 * copied, while the revocable preview URL is dropped so a retained snapshot
 * never depends on the visible draft's browser resource lifecycle. The clone
 * is a borrower: it never revokes, because its source stays live in the
 * draft (or, after queue/worktree capture, was already released there by
 * `serializeAttachmentsForQueue`). See the ownership rule in `input-store.ts`.
 */
export const cloneAttachmentSnapshot = (file: AttachedFile): AttachedFile => ({
  ...file,
  previewUrl: undefined,
  uploadState: file.uploadState
    ? ({ ...file.uploadState } as AttachedFile['uploadState'])
    : file.uploadState,
});

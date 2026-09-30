import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import {
  shouldApplySentDraftClear,
  useInputStore,
} from "./input-store"

/**
 * Regression coverage for the remount-safe successful-send clear.
 *
 * A sending composer can unmount mid-send (the busy flip swaps the
 * transcript branch to a fresh `ChatInput` whose unmount flush persisted the
 * still-unsent text). The sender persists the cleared draft and publishes a
 * one-shot `sentDraftClear` signal; the instance currently owning the same
 * draft key consumes it and clears only on exact text match.
 *
 * Self-contained: the real store is used, no workspace module mocks are
 * installed (per-file isolation), and object-URL revocation is observed
 * through local `globalThis` stubs restored after each run.
 */

const DRAFT_KEY = JSON.stringify(["runtime-a", "/work/project", "session-1"])
const OTHER_KEY = JSON.stringify(["runtime-a", "/work/project", "session-2"])
const SENT_TEXT = "restored reverted message"

const resetStore = (): void => {
  useInputStore.setState({
    attachedFiles: [],
    stashedAttachmentsByDraft: {},
    activeAttachmentsDraftKey: null,
    sentDraftClear: null,
  })
}

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

let urlCounter = 0
let revoked: string[] = []

const nextPreviewUrl = (): string => {
  urlCounter += 1
  return `blob:mock-sent-clear-${urlCounter}`
}

const sendableFile = (id: string): AttachedFile => ({
  id,
  file: new File(["payload"], `${id}.png`, { type: "image/png" }),
  dataUrl: "data:image/png;base64,cGF5bG9hZA==",
  previewUrl: nextPreviewUrl(),
  mimeType: "image/png",
  filename: `${id}.png`,
  size: 1024,
  source: "local",
  uploadState: { status: "ready", attachmentId: `opaque-${id}`, expiresAt: Date.now() + 60_000 },
})

describe("sent-draft clear signal", () => {
  beforeEach(() => {
    revoked = []
    URL.createObjectURL = (() => nextPreviewUrl()) as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = ((url: string) => {
      revoked.push(url)
    }) as unknown as typeof URL.revokeObjectURL
    resetStore()
  })

  afterEach(() => {
    resetStore()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
  })

  test("publishes a keyed signal with the exact sent text", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)

    const signal = useInputStore.getState().sentDraftClear
    expect(signal).not.toBeNull()
    expect(signal?.draftKey).toBe(DRAFT_KEY)
    expect(signal?.text).toBe(SENT_TEXT)
    expect(typeof signal?.nonce).toBe("number")
  })

  test("a matching consumer applies the signal and consumes it one-shot", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const signal = useInputStore.getState().sentDraftClear
    expect(signal).not.toBeNull()

    // The remounted instance still shows exactly what was sent.
    expect(shouldApplySentDraftClear(signal, DRAFT_KEY, SENT_TEXT)).toBe(true)

    useInputStore.getState().consumeSentDraftClear(signal!.nonce)
    expect(useInputStore.getState().sentDraftClear).toBeNull()
  })

  test("does not apply when the composer text was edited", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const signal = useInputStore.getState().sentDraftClear

    expect(shouldApplySentDraftClear(signal, DRAFT_KEY, `${SENT_TEXT} plus type-ahead`)).toBe(false)
    expect(shouldApplySentDraftClear(signal, DRAFT_KEY, "")).toBe(false)
    expect(shouldApplySentDraftClear(signal, DRAFT_KEY, ` ${SENT_TEXT}`)).toBe(false)
  })

  test("does not apply to a different draft key", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const signal = useInputStore.getState().sentDraftClear

    expect(shouldApplySentDraftClear(signal, OTHER_KEY, SENT_TEXT)).toBe(false)
    expect(shouldApplySentDraftClear(null, DRAFT_KEY, SENT_TEXT)).toBe(false)
  })

  test("is one-shot: a second mount does not clear again", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const first = useInputStore.getState().sentDraftClear
    expect(shouldApplySentDraftClear(first, DRAFT_KEY, SENT_TEXT)).toBe(true)

    useInputStore.getState().consumeSentDraftClear(first!.nonce)

    // A later mount observes no signal, even with identical text on screen.
    const second = useInputStore.getState().sentDraftClear
    expect(second).toBeNull()
    expect(shouldApplySentDraftClear(second, DRAFT_KEY, SENT_TEXT)).toBe(false)
  })

  test("repeated identical sends each publish a distinct clear", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const first = useInputStore.getState().sentDraftClear
    useInputStore.getState().consumeSentDraftClear(first!.nonce)

    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const second = useInputStore.getState().sentDraftClear
    expect(second).not.toBeNull()
    expect(second!.nonce).not.toBe(first!.nonce)
    expect(shouldApplySentDraftClear(second, DRAFT_KEY, SENT_TEXT)).toBe(true)
  })

  test("consuming a stale nonce never drops a newer signal", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    const stale = useInputStore.getState().sentDraftClear
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, `${SENT_TEXT} again`)
    const current = useInputStore.getState().sentDraftClear
    expect(current!.nonce).not.toBe(stale!.nonce)

    useInputStore.getState().consumeSentDraftClear(stale!.nonce)
    expect(useInputStore.getState().sentDraftClear?.nonce).toBe(current!.nonce)
  })

  test("runtime switch drops a pending signal", () => {
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)
    expect(useInputStore.getState().sentDraftClear).not.toBeNull()

    useInputStore.getState().resetForRuntimeSwitch()
    expect(useInputStore.getState().sentDraftClear).toBeNull()
  })

  test("unmount-during-send: a remounted owner clears stale text exactly once", () => {
    // The sending instance unmounted mid-send; the remounted instance shows
    // the stale persisted text X. The (dead) sender persisted the cleared
    // draft and published the signal after acceptance.
    useInputStore.getState().publishSentDraftClear(DRAFT_KEY, SENT_TEXT)

    // Remounted consumer: key matches, text still exactly X → clears.
    const observed = useInputStore.getState().sentDraftClear
    expect(shouldApplySentDraftClear(observed, DRAFT_KEY, SENT_TEXT)).toBe(true)
    useInputStore.getState().consumeSentDraftClear(observed!.nonce)

    // A further remount (or the same instance re-rendering) fires nothing.
    expect(useInputStore.getState().sentDraftClear).toBeNull()
  })

  test("success detaches sent attachments once with no double revoke", () => {
    const file = sendableFile("sent-image")
    const sourceUrl = file.previewUrl
    useInputStore.getState().setAttachedFiles([file])

    // Mirrors the success path: detach the captured ids after acceptance.
    useInputStore.getState().detachAttachedFiles([file.id])
    expect(useInputStore.getState().attachedFiles).toEqual([])
    // A repeated detach (stashed sweep, retried cleanup) must not revoke again.
    useInputStore.getState().detachAttachedFiles([file.id])

    expect(revoked.filter((url) => url === sourceUrl)).toHaveLength(1)
  })

  test("failure keeps attachments with working previews for retry", () => {
    const file = sendableFile("kept-image")
    const sourceUrl = file.previewUrl
    useInputStore.getState().setAttachedFiles([file])

    // The failure path publishes no clear signal and detaches nothing.
    expect(useInputStore.getState().sentDraftClear).toBeNull()
    expect(useInputStore.getState().attachedFiles.map((entry) => entry.id)).toEqual([file.id])
    expect(useInputStore.getState().attachedFiles[0].previewUrl).toBe(sourceUrl)
    expect(revoked).toEqual([])
  })
})

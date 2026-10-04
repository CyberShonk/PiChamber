import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { serializeAttachmentsForQueue, useInputStore } from "./input-store"

/**
 * Preview URL ownership coverage for `input-store.ts`.
 *
 * Self-contained: `URL.createObjectURL` / `URL.revokeObjectURL` are stubbed
 * on `globalThis` within this file and restored after, and no workspace
 * module mocks are used (per-file isolation).
 */

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

let urlCounter = 0
let revoked: string[] = []

const installUrlStubs = (): void => {
  // Monotonic: real object URLs are unique per creation, and the store's
  // revoked-URL guard persists for the module lifetime, so reusing a mock
  // URL across tests would wrongly hit the guard.
  revoked = []
  URL.createObjectURL = ((() => {
    urlCounter += 1
    return `blob:mock-${urlCounter}`
  }) as unknown) as typeof URL.createObjectURL
  URL.revokeObjectURL = (((url: string) => {
    revoked.push(url)
  }) as unknown) as typeof URL.revokeObjectURL
}

const restoreUrlStubs = (): void => {
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
}

const localImage = (id: string, size = 1024): AttachedFile => ({
  id,
  file: new File(["payload"], `${id}.png`, { type: "image/png" }),
  dataUrl: "data:image/png;base64,cGF5bG9hZA==",
  previewUrl: URL.createObjectURL(new Blob(["preview"])),
  mimeType: "image/png",
  filename: `${id}.png`,
  size,
  source: "local",
  uploadState: { status: "ready", attachmentId: `opaque-${id}`, expiresAt: Date.now() + 60_000 },
})

const resetStore = (): void => {
  useInputStore.setState({
    attachedFiles: [],
    stashedAttachmentsByDraft: {},
    activeAttachmentsDraftKey: null,
  })
}

const installFileReader = (): (() => void) => {
  const Original = (globalThis as unknown as { FileReader?: unknown }).FileReader
  class StubFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then(
        (buffer) => {
          const bytes = new Uint8Array(buffer)
          let binary = ""
          for (const byte of bytes) binary += String.fromCharCode(byte)
          const base64 = Buffer.from(binary, "binary").toString("base64")
          const mime = (blob as File).type || "application/octet-stream"
          this.result = `data:${mime};base64,${base64}`
          queueMicrotask(() => this.onload?.())
        },
        () => queueMicrotask(() => this.onerror?.()),
      )
    }
  }
  ;(globalThis as unknown as { FileReader: unknown }).FileReader = StubFileReader
  return () => {
    if (Original === undefined) delete (globalThis as unknown as { FileReader?: unknown }).FileReader
    else (globalThis as unknown as { FileReader: unknown }).FileReader = Original
  }
}

describe("input-store preview URL ownership", () => {
  beforeEach(() => {
    installUrlStubs()
    resetStore()
  })

  afterEach(() => {
    resetStore()
    restoreUrlStubs()
  })

  test("serialize-for-queue strips the preview URL without releasing the draft's copy", async () => {
    const file = localImage("a")
    const sourceUrl = file.previewUrl
    const [copy] = await serializeAttachmentsForQueue([file])

    expect(copy.previewUrl).toBeUndefined()
    expect(copy.dataUrl.startsWith("data:")).toBe(true)
    expect(file.previewUrl).toBe(sourceUrl)
    expect(revoked).toEqual([])
  })

  test("serialize-for-queue keeps the source URL alive on the blob-read branch too", async () => {
    const restoreFileReader = installFileReader()
    try {
      const file: AttachedFile = {
        ...localImage("b"),
        dataUrl: "",
        file: new File(["real-bytes"], "b.png", { type: "image/png" }),
      }
      const sourceUrl = file.previewUrl
      const [copy] = await serializeAttachmentsForQueue([file])

      expect(copy.previewUrl).toBeUndefined()
      expect(copy.dataUrl).toBe(`data:image/png;base64,${Buffer.from("real-bytes").toString("base64")}`)
      expect(file.previewUrl).toBe(sourceUrl)
      expect(revoked).toEqual([])
    } finally {
      restoreFileReader()
    }
  })

  test("clear revokes visible preview URLs", () => {
    const file = localImage("a")
    useInputStore.getState().setAttachedFiles([file])
    useInputStore.getState().clearAttachedFiles()

    expect(revoked).toEqual([file.previewUrl])
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("submit detach revokes the sent preview URLs", () => {
    const file = localImage("a")
    useInputStore.getState().setAttachedFiles([file])
    useInputStore.getState().detachAttachedFiles([file.id])

    expect(revoked).toEqual([file.previewUrl])
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("stash keeps the URL alive and restore reuses it", () => {
    const file = localImage("a")
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    useInputStore.getState().setAttachedFiles([file])

    useInputStore.getState().activateAttachmentsDraft("draft-b")
    expect(useInputStore.getState().attachedFiles).toEqual([])
    expect(revoked).toEqual([])

    useInputStore.getState().activateAttachmentsDraft("draft-a")
    expect(useInputStore.getState().attachedFiles).toHaveLength(1)
    expect(useInputStore.getState().attachedFiles[0].previewUrl).toBe(file.previewUrl)
    expect(revoked).toEqual([])
  })

  test("stash count eviction revokes the oldest draft first", () => {
    useInputStore.getState().activateAttachmentsDraft("draft-0")
    const oldest = localImage("file-0")
    useInputStore.getState().setAttachedFiles([oldest])
    for (let index = 1; index <= 10; index += 1) {
      useInputStore.getState().activateAttachmentsDraft(`draft-${index}`)
      useInputStore.getState().setAttachedFiles([localImage(`file-${index}`)])
    }

    // Eleven stashed drafts exceed the ten-entry bound once the eleventh
    // visible draft is stashed away.
    useInputStore.getState().activateAttachmentsDraft("draft-11")
    expect(Object.keys(useInputStore.getState().stashedAttachmentsByDraft)).toHaveLength(10)
    expect(revoked).toEqual([oldest.previewUrl])
  })

  test("stash byte eviction revokes the oldest draft first", () => {
    const thirtyMb = 30 * 1024 * 1024
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    const oldest = localImage("big-a", thirtyMb)
    useInputStore.getState().setAttachedFiles([oldest])

    useInputStore.getState().activateAttachmentsDraft("draft-b")
    const newest = localImage("big-b", thirtyMb)
    useInputStore.getState().setAttachedFiles([newest])
    expect(revoked).toEqual([])

    // Stashing the second 30 MB draft pushes the stash to 60 MB, past the
    // 50 MB bound, so the oldest draft is evicted and released.
    useInputStore.getState().activateAttachmentsDraft("draft-c")
    expect(revoked).toEqual([oldest.previewUrl])
    expect(useInputStore.getState().stashedAttachmentsByDraft["draft-a"]).toBeUndefined()
  })

  test("serialize defers release to detach, which revokes once", async () => {
    const file = localImage("a")
    useInputStore.getState().setAttachedFiles([file])

    await serializeAttachmentsForQueue(useInputStore.getState().attachedFiles)
    expect(revoked).toEqual([])
    useInputStore.getState().detachAttachedFiles([file.id])
    useInputStore.getState().detachAttachedFiles([file.id])

    expect(revoked.filter((url) => url === file.previewUrl)).toHaveLength(1)
  })

  test("removeAttachedFile revokes exactly once", () => {
    const file = localImage("a")
    useInputStore.getState().setAttachedFiles([file])
    useInputStore.getState().removeAttachedFile(file.id)

    expect(revoked).toEqual([file.previewUrl])
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("detach revokes stashed originals for a send that resolves after a draft switch", () => {
    const current = localImage("current")
    useInputStore.getState().setAttachedFiles([current])
    useInputStore.getState().activateAttachmentsDraft("draft-a")
    useInputStore.getState().activateAttachmentsDraft("draft-b")
    const stashed = localImage("stashed")
    useInputStore.getState().setAttachedFiles([stashed])
    useInputStore.getState().activateAttachmentsDraft("draft-a")

    useInputStore.getState().detachAttachedFiles([stashed.id, current.id, "missing-id"])
    expect(useInputStore.getState().attachedFiles).toEqual([])
    expect(useInputStore.getState().stashedAttachmentsByDraft).toEqual({})
    expect(revoked).toHaveLength(2)
    expect(revoked).toContain(stashed.previewUrl)
    expect(revoked).toContain(current.previewUrl)
  })

  test("setAttachedFiles keeps previews for files that survive the replace", () => {
    const retained = localImage("retained")
    useInputStore.getState().setAttachedFiles([retained])

    // Queued-edit restore (`popToInput`) re-adds the visible files it holds
    // alongside the popped entry: the retained preview must survive.
    const popped: AttachedFile = { ...localImage("popped"), previewUrl: undefined }
    useInputStore.getState().setAttachedFiles([retained, popped])

    expect(revoked).toEqual([])
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(["retained", "popped"])
  })

  test("session cleanup revokes that session's stashed previews", () => {
    const key = JSON.stringify(["rk", "/dir", "s1"])
    const file = localImage("a")
    useInputStore.getState().activateAttachmentsDraft(key)
    useInputStore.getState().setAttachedFiles([file])
    useInputStore.getState().activateAttachmentsDraft("other")

    useInputStore.getState().clearStashedAttachmentsForSession({ runtimeKey: "rk", directory: "/dir", sessionId: "s1" })
    expect(revoked).toEqual([file.previewUrl])
  })
})

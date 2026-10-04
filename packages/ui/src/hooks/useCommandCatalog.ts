import React from "react";

import { piClient } from "@/lib/pi/client";
import {
  adoptCommandCatalogSignatures,
  buildSystemCatalogCommands,
  clearCommandCatalogForRuntimeSwitch,
  getCommandCatalogInvalidationRevision,
  isCommandCatalogEntryFresh,
  readCommandCatalogCache,
  readCommandCatalogEntry,
  subscribeCommandCatalogInvalidation,
  toCatalogCommands,
  writeCommandCatalogCache,
  type CatalogCommand,
} from "@/lib/pi/commandCatalog";
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from "@/lib/runtime-switch";
import { usePromptTemplatesStore } from "@/stores/usePromptTemplatesStore";
import { useSkillsStore } from "@/stores/useSkillsStore";

interface InFlightCatalogRequest {
  promise: Promise<CatalogCommand[] | null>;
  /** Store signatures observed when the request started. */
  promptSignature: string;
  skillSignature: string;
}

const inFlightByScope = new Map<string, InFlightCatalogRequest>();

const scopeKey = (runtimeKey: string, directory?: string): string =>
  `${runtimeKey}\n${directory?.trim() ?? ""}`;

/**
 * Authoritative slash-command catalog for an effective directory.
 *
 * Combines PiChamber system commands with native Pi prompts, skills
 * (`skill:name`), and extension commands from `/api/pi/commands`. Scoped by
 * runtime + directory; failed refreshes preserve the last known catalog for
 * the same scope and never become empty success. Runtime switches clear.
 *
 * Prompt create/update/delete, extension reload, and skill reload invalidate
 * via their owning stores (which bump the observed revisions below) so both
 * `/` autocomplete and composer highlighting agree.
 */
export function useCommandCatalog(directory?: string): {
  commands: CatalogCommand[];
  isLoading: boolean;
} {
  const normalizedDirectory = directory?.trim() ? directory.trim() : undefined;
  const invalidationRevision = React.useSyncExternalStore(
    subscribeCommandCatalogInvalidation,
    getCommandCatalogInvalidationRevision,
    getCommandCatalogInvalidationRevision,
  );
  // Prompt and skill mutations update these stores from their mutation
  // responses; observing their identities invalidates this catalog without
  // duplicating Pi resource discovery here.
  const promptSignature = usePromptTemplatesStore((s) =>
    s.prompts.map((p) => `${p.id}:${p.name}:${p.location}`).join("|"),
  );
  const skillSignature = useSkillsStore((s) =>
    s.skills.map((sk) => `${sk.id}:${sk.name}:${sk.scope}`).join("|"),
  );

  const [commands, setCommands] = React.useState<CatalogCommand[]>(() => {
    if (!normalizedDirectory) return buildSystemCatalogCommands();
    const cached = readCommandCatalogCache(getRuntimeKey(), normalizedDirectory);
    return cached ? [...buildSystemCatalogCommands(), ...cached] : buildSystemCatalogCommands();
  });
  const [isLoading, setIsLoading] = React.useState(false);
  const [runtimeEpoch, setRuntimeEpoch] = React.useState(0);
  const lastScopeRef = React.useRef<string | undefined>(undefined);
  // Latest store signatures for completion-time bookkeeping. Updated in a
  // dedicated effect that runs before the fetch effect, so a request always
  // starts under current signatures and completions can compare against the
  // latest ones.
  const latestSignaturesRef = React.useRef({ promptSignature: '', skillSignature: '' });
  React.useEffect(() => {
    latestSignaturesRef.current = { promptSignature, skillSignature };
  }, [promptSignature, skillSignature]);

  // Runtime switches must never reuse the previous server's commands.
  React.useEffect(() => {
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      clearCommandCatalogForRuntimeSwitch();
      inFlightByScope.clear();
      lastScopeRef.current = undefined;
      setCommands(buildSystemCatalogCommands());
      setRuntimeEpoch((e) => e + 1);
    });
    return unsubscribe;
  }, []);

  React.useEffect(() => {
    const runtimeKey = getRuntimeKey();
    const scope = scopeKey(runtimeKey, normalizedDirectory);
    const requestKey = `${scope}\n${invalidationRevision}`;
    if (!normalizedDirectory) {
      lastScopeRef.current = scope;
      setCommands(buildSystemCatalogCommands());
      return;
    }
    // Directory switches never show another directory's rows while loading.
    if (lastScopeRef.current !== scope) {
      lastScopeRef.current = scope;
      const cached = readCommandCatalogCache(runtimeKey, normalizedDirectory);
      setCommands(cached ? [...buildSystemCatalogCommands(), ...cached] : buildSystemCatalogCommands());
    }
    // A fresh entry validated against the same store signatures needs no
    // fetch: this keeps the two mounts on one shared request and makes a
    // remount within the freshness window cost zero requests. An entry
    // recorded before the prompt/skill stores finished their first load
    // (empty recorded signatures) is adopted on empty → loaded without
    // refetching — the commands response already reflects those resources
    // server-side, so the boot transition is not a real change. A real
    // change (loaded → different) still refetches below.
    const entry = readCommandCatalogEntry(runtimeKey, normalizedDirectory);
    if (entry && isCommandCatalogEntryFresh(entry)) {
      const promptChanged = entry.promptSignature !== '' && entry.promptSignature !== promptSignature;
      const skillChanged = entry.skillSignature !== '' && entry.skillSignature !== skillSignature;
      if (!promptChanged && !skillChanged) {
        if (entry.promptSignature !== promptSignature || entry.skillSignature !== skillSignature) {
          adoptCommandCatalogSignatures(runtimeKey, normalizedDirectory, promptSignature, skillSignature);
        }
        setIsLoading(false);
        return;
      }
    }
    let cancelled = false;
    setIsLoading(true);
    const startRequest = (): void => {
      const existing = inFlightByScope.get(requestKey);
      let inflight: InFlightCatalogRequest;
      if (existing) {
        inflight = existing;
      } else {
        const requestRevision = invalidationRevision;
        const requestPromptSignature = latestSignaturesRef.current.promptSignature;
        const requestSkillSignature = latestSignaturesRef.current.skillSignature;
        const inFlightHolder: { promise?: Promise<CatalogCommand[] | null> } = {};
        const promise = (async () => {
          try {
            const result = await piClient.listCommands(normalizedDirectory, { runtimeKey });
            if (getRuntimeKey() !== runtimeKey) return null;
            if (getCommandCatalogInvalidationRevision() !== requestRevision) return null;
            const catalog = toCatalogCommands(result.commands);
            // Record the signatures the request started under. A real store
            // change that lands mid-flight is handled by the follow-up
            // below, never by stamping possibly-stale data as validated.
            writeCommandCatalogCache(runtimeKey, normalizedDirectory, catalog, {
              promptSignature: requestPromptSignature,
              skillSignature: requestSkillSignature,
            });
            return catalog;
          } catch {
            return null;
          } finally {
            if (inFlightByScope.get(requestKey)?.promise === inFlightHolder.promise) {
              inFlightByScope.delete(requestKey);
            }
          }
        })();
        inFlightHolder.promise = promise;
        inflight = { promise, promptSignature: requestPromptSignature, skillSignature: requestSkillSignature };
        inFlightByScope.set(requestKey, inflight);
      }
      void inflight.promise.then((catalog) => {
        if (cancelled) return;
        if (getRuntimeKey() !== runtimeKey) return;
        // Failure preserves the last known catalog for the same scope;
        // only a successful authoritative fetch replaces it, and only a
        // success marks the entry fresh (the write above).
        if (catalog) {
          setCommands([...buildSystemCatalogCommands(), ...catalog]);
          // A real store change that landed while the request was in flight
          // may postdate the response: follow up once so the edit is not
          // stuck behind the shared in-flight result. Empty → loaded is not
          // a real change, so boot-time store loads never chain here.
          const latest = latestSignaturesRef.current;
          const promptChangedMidFlight =
            inflight.promptSignature !== '' && inflight.promptSignature !== latest.promptSignature;
          const skillChangedMidFlight =
            inflight.skillSignature !== '' && inflight.skillSignature !== latest.skillSignature;
          if (promptChangedMidFlight || skillChangedMidFlight) {
            startRequest();
            return;
          }
        }
        setIsLoading(false);
      }).catch(() => {
        if (!cancelled) setIsLoading(false);
      });
    };
    startRequest();
    return () => {
      cancelled = true;
    };
  }, [normalizedDirectory, promptSignature, skillSignature, runtimeEpoch, invalidationRevision]);

  return { commands, isLoading };
}

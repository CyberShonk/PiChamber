// Git library public entrypoint
// Re-exports all Git operations from the service module.
//
// Invariant: PiChamber never writes git config for identity or credentials.
// The only author read is the read-only getCurrentIdentity (served at
// GET /api/git/current-identity). The retired commit-author profiles feature
// (profile storage, credential discovery, and the local-config writer) was
// removed along with its routes; any previously saved profiles file or
// previously written repo config is left untouched on disk.

export * from './service.js';

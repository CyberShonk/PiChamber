/** GitHub module entrypoint. See DOCUMENTATION.md. */

import { createChecksService } from './checks.js';
import { createGitHubClient } from './client.js';
import { createContextBuilder } from './context.js';
import { createCredentialStore } from './credential.js';
import { createGhCli } from './gh-cli.js';
import { createIssuesService } from './issues.js';
import { createPullsService } from './pulls.js';
import { createTemplatesService } from './templates.js';
import { createRepoInfoLoader, createRepoScopeResolver } from './repo-scope.js';
import { createGitHubRoutes, registerGitHubRoutes } from './routes.js';

export {
  createGitHubRoutes,
  registerGitHubRoutes,
  createGhCli,
  createCredentialStore,
  createGitHubClient,
  createRepoScopeResolver,
  createRepoInfoLoader,
  createPullsService,
  createIssuesService,
  createChecksService,
  createTemplatesService,
  createContextBuilder,
};

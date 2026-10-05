import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import handoff from './handoff.ts';
import supervisor from './session-supervisor.ts';
import sync from './codegraph-auto-sync.ts';
import guard from './codegraph-guard.ts';
import recovery from './recovery.ts';

export default function (pi: ExtensionAPI) {
  handoff(pi);
  sync(pi);
  guard(pi);

  // Recovery should observe settled state before the supervisor
  // potentially starts a handoff/new-session transition.
  recovery(pi);

  supervisor(pi);
}
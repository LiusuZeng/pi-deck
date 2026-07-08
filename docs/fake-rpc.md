# Fake Pi RPC Harness

Eng 2 added a deterministic fake `pi --mode rpc`-style subprocess for backend and future frontend integration tests.

Source:

```text
src/main/pi/fakeRpc/fakeRpcServer.ts
```

For tests, use the shared harness rather than relying on a built output path:

```text
src/test/fakeRpcHarness.ts
```

The harness bundles the fake server with esbuild, spawns it for Vitest, and can write a temporary `pi` shim so platform smoke-test code exercises the same fake-RPC implementation.

Direct Node execution of a built server is development-only if your local build emits a compatible path; the Electron main build does not guarantee a stable `dist/src/main/...` layout.

The fake process speaks the same LF-delimited JSONL framing used by `JsonlRpcClient`:

```jsonl
{"id":"1","type":"command","command":"get_state","params":{}}
{"id":"2","type":"command","command":"prompt","params":{"text":"hello"}}
```

Supported commands:

- `get_state` — returns deterministic session/cwd/model state.
- `get_messages` — returns deterministic in-memory messages.
- `prompt` — immediately returns an accepted response, then emits `agent_start`, streaming `message_update`, and `agent_end` events.
- `abort` — stops pending stream timers and emits an `agent_end` event with `status: "aborted"`.

Useful fixture flags:

- `--stream-delay-ms <n>` — controls deterministic streaming delay.
- `--stderr-on-start` — writes a stderr diagnostic for log-buffer tests.
- `--malformed-on-start` — emits malformed stdout for parser/error handling tests.
- `--exit-after-first-command` — exits before responding to the first command for pending-request rejection tests.
- `--ignore-command <name>` — accepts a command but never responds, for deterministic timeout tests.
- `--drop-completion-events` — persists the final assistant message and marks fake state idle, but does not emit final `message_update done` or `agent_end`; useful for UI reconciliation regressions.
- `--prompt-scenario <name>` — emits additional deterministic prompt-side events. Supported names:
  - `basic` — default `agent_start`, streaming `message_update`, `agent_end`.
  - `tool` — adds `tool_execution_start/update/end`.
  - `queue` — adds `queue_update` with steering/follow-up counts.
  - `compaction` — adds `compaction_start/end`.
  - `retry` — adds `auto_retry_start/end`.
  - `extension-ui` — adds a `confirm` `extension_ui_request` with a timeout.
  - `all` — emits every extension fixture event above.

G4 extension UI follow-up: the fake currently emits request events only. It does not yet simulate `respondToExtensionUi`, Pi-side timeout resolution, late-response suppression, or stdin write failure. Add those fixtures once the extension UI backend/write path exists.

The fake accepts both JSONL command encodings used in tests:

```jsonl
{"id":"1","type":"command","command":"get_state","params":{}}
{"id":"2","type":"get_state"}
```

Example test usage:

```ts
import { buildFakeRpcServer } from "../../test/fakeRpcHarness.js";

new PiWorker({
  command: process.execPath,
  args: [buildFakeRpcServer(), "--stream-delay-ms", "1"],
  cwd: process.cwd(),
});
```

Related QA artifacts:

- `docs/state-reducer-fixtures.json` — canonical reducer fixture cases for M5.
- `docs/real-pi-smoke-test-matrix.md` — real Pi validation matrix for G1-G4 and MVP acceptance.

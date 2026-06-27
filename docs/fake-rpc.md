# Fake Pi RPC Harness

Eng 2 added a deterministic fake `pi --mode rpc`-style subprocess for backend and future frontend integration tests.

Source:

```text
src/main/pi/fakeRpc/fakeRpcServer.ts
```

Build and run it through Node after `npm run build`:

```bash
node dist/src/main/pi/fakeRpc/fakeRpcServer.js
```

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

Example PiWorker test configuration:

```ts
new PiWorker({
  command: process.execPath,
  args: ["dist/src/main/pi/fakeRpc/fakeRpcServer.js", "--stream-delay-ms", "1"],
  cwd: process.cwd(),
});
```

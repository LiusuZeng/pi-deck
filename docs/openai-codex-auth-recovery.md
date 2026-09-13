# OpenAI Codex authentication recovery

Pi Deck does not store or inspect OpenAI credentials. If Pi reports a narrow
OpenAI Codex OAuth expiry/revocation failure, choose **Re-authenticate with Pi**.
Pi Deck opens the configured installed Pi binary in Terminal using the same Pi
agent directory as workers; in Pi run `/login openai-codex` and finish the
ChatGPT subscription login.

Return to Pi Deck and choose **Check again / Resume** for each affected session.
That closes an unusable runtime and creates a new one against the same canonical
Pi session file and workspace. Reopening verifies only that Pi can start, so Pi
Deck keeps the original authentication diagnostic and recovery actions visible
until an explicit new model prompt completes successfully. It does not replay
the failed turn or tool calls.

The real-Pi re-login smoke remains release-only: automated CI and local test
runs must not modify a developer's ChatGPT/Pi credentials. Deterministic fake
RPC coverage validates the production-shaped expiry, terminal command/path
construction, durable same-session reopen, and relaunch behavior.

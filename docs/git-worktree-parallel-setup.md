# Git Worktree Setup for Parallel Pi Deck Development

Use Git worktrees so multiple engineering agents can work on the same laptop without overwriting each other's files or fighting over one working directory.

## Recommended Directory Layout

Assume the main checkout is:

```text
/Users/liusu/liusu_pi_gui
```

Create sibling worktrees:

```text
/Users/liusu/pi-deck-worktrees/
  eng1-electron-security/
  eng2-rpc-backend/
  eng3-platform-env/
  eng4-frontend-chat/
  eng5-sessions-controls/
  eng6-qa-automation/
```

## One-Time Setup

From the main repo:

```bash
mkdir -p /Users/liusu/pi-deck-worktrees

git worktree add -b eng1/electron-security /Users/liusu/pi-deck-worktrees/eng1-electron-security

git worktree add -b eng2/rpc-backend /Users/liusu/pi-deck-worktrees/eng2-rpc-backend

git worktree add -b eng3/platform-env /Users/liusu/pi-deck-worktrees/eng3-platform-env

git worktree add -b eng4/frontend-chat /Users/liusu/pi-deck-worktrees/eng4-frontend-chat

git worktree add -b eng5/sessions-controls /Users/liusu/pi-deck-worktrees/eng5-sessions-controls

git worktree add -b eng6/qa-automation /Users/liusu/pi-deck-worktrees/eng6-qa-automation
```

Each agent should operate only inside its assigned worktree.

## Agent Assignment

| Agent | Branch | Worktree path | Primary scope |
|---|---|---|---|
| Eng 1 | `eng1/electron-security` | `/Users/liusu/pi-deck-worktrees/eng1-electron-security` | Electron scaffold, secure IPC, settings/logs |
| Eng 2 | `eng2/rpc-backend` | `/Users/liusu/pi-deck-worktrees/eng2-rpc-backend` | JSONL transport, fake RPC, PiWorker |
| Eng 3 | `eng3/platform-env` | `/Users/liusu/pi-deck-worktrees/eng3-platform-env` | Pi binary resolution, smoke test, EffectivePiConfig |
| Eng 4 | `eng4/frontend-chat` | `/Users/liusu/pi-deck-worktrees/eng4-frontend-chat` | Layout, chat timeline, composer |
| Eng 5 | `eng5/sessions-controls` | `/Users/liusu/pi-deck-worktrees/eng5-sessions-controls` | Project/session/sidebar controls |
| Eng 6 | `eng6/qa-automation` | `/Users/liusu/pi-deck-worktrees/eng6-qa-automation` | Tests, fake fixtures, acceptance matrix |

## Agent Prompt Addition

Add this to every engineering agent prompt:

```text
Work only inside your assigned git worktree. Do not modify files in the main checkout or another engineer's worktree. Before editing, run `pwd`, `git branch --show-current`, and `git status --short` to verify you are in the correct worktree/branch.
```

## Coordination Rules

1. **Shared contracts first.** Changes to shared files like IPC schemas, `PiAdapter`, event models, or package/build config should be coordinated before implementation.
2. **Small PRs/merge chunks.** Each engineer should commit coherent chunks and avoid large unrelated changes.
3. **Prefer additive changes early.** To reduce merge conflicts, create new modules/files when possible until contracts stabilize.
4. **Dependency changes require coordination.** Any package.json, lockfile, tsconfig, build config, or Electron config changes should be announced because they affect all worktrees.
5. **Docs tracker updates can conflict.** Either the orchestrator updates tracker docs centrally, or each engineer updates only their assigned rows.

## Syncing with Main

After another branch merges to main, each worktree should update:

```bash
git fetch origin
# If main is local-only, first ensure the main branch has the latest merged work.
git rebase main
```

If using local merges without remote:

```bash
git checkout main
git merge eng1/electron-security

cd /Users/liusu/pi-deck-worktrees/eng2-rpc-backend
git rebase main
```

## Cleaning Up Worktrees

After a branch is merged and no longer needed:

```bash
git worktree remove /Users/liusu/pi-deck-worktrees/eng1-electron-security
git branch -d eng1/electron-security
```

Use `git worktree list` to see active worktrees.

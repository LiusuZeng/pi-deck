# Pi Deck

**Pi Deck — a local command deck for Pi agents.**

Pi Deck is a planned local macOS GUI/control plane for running and managing Pi coding-agent sessions without launching Pi's terminal UI.

## Naming

- Display name: Pi Deck
- Repo/package name: `pi-deck`
- App identifier: `com.liusu.pideck` or `com.pideck.app`
- Docs short name: Pi Deck

## Starting Pi Deck

```bash
npm install
npm run build                      # required once after clone or source changes
npm start                          # existing dist, real Pi backend, current directory as project
npm run deck:real -- /path/project # existing dist, real Pi backend for a specific project
npm run dev:real -- /path/project  # real Pi backend with Vite renderer dev loop
npm run deck:fake                  # existing dist, safe fake-backend demo mode
```

`npm start` never rebuilds. Use `npm run launch:build` (or `npm run deck:real:build -- /path/project`) when development or CI needs to build and launch in one command.

See [How to run and test](docs/how-to-run-and-test.md) for launcher options and validation commands.

## Project docs

- [Requirements](docs/requirements.md)
- [Technical architecture](docs/technical-architecture.md)
- [Project task breakdown](docs/project-task-breakdown.md)
- [Project tracker](docs/project-tracker.md)
- [Engineering design review notes](docs/engineering-design-review-notes.md)

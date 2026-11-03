# Generated user LaunchAgents

These are XML templates consumed by `scripts/install-service.ts`. Generate a fresh output directory using the absolute Node 24 executable and private environment/configuration paths. Follow [deployment.md](../../docs/deployment.md) for the command and service lifecycle.

The generator writes `com.patrick.workbench.plist`, `com.patrick.backup.plist` and `INSTALL.md`. It does not call `launchctl`, copy files into `~/Library/LaunchAgents`, install Lima, or start a VM. Secrets stay in the separately protected environment files; generated plists contain their paths only. All substitutions are XML-escaped, and each `ProgramArguments` item is one argument, including paths with spaces or Chinese characters.

The workbench runs built `dist/index.js` from the repository root. Its existing in-process network guardian runs on startup and every 60 seconds; do not load a second writer or network host as another LaunchAgent. The backup job invokes the online SQLite snapshot entry point daily at 03:15 local time. Restic runs only when its private backup environment configures an approved repository and password file.

These are user agents that run while that account is logged in. A macOS login agent does not establish unattended operation before login, survive a powered-off machine, or configure a VPN. Those need separate host acceptance. Review the generated `INSTALL.md` before loading either job.

# macOS host setup and recovery

This package generates a local service definition and supplies isolation/network examples. Generating these files installs no LaunchAgent, VM, VPN, restic repository or off-machine backup. A later bounded Lima trial on the current MacBook Pro is recorded below; it does not qualify the planned production Mac mini. Restic remains unconfigured, and live delivery, VPN and encrypted recovery still need their individual evidence. See [operations.md](operations.md) for integration settings and [acceptance.md](acceptance.md) for acceptance records.

## Build and private paths

Use Node 24 for installation, native dependencies, checks and the persistent process. An interactive nvm selection does not configure launchd. From this repository:

```sh
nvm use 24
node --version
npm ci
npm run build
```

Keep the active SQLite database/WAL, its `writer.lock` and `host-lease.db`, generated access token, log files and secret environment files outside synchronized storage. The generated service uses `dataDir/vault` so database and published Vault can be recovered together. Use a private local directory with mode `700`, and owner-only regular environment files with mode `600`. The generator checks environment file ownership/permissions without reading their contents. It resolves the real Node executable and requires `v24.*` plus an existing `dist/index.js`.

Prepare two private files using [.env.example](../.env.example): `service.env` with the authorized service credentials, and `backup.env` with only backup settings. Use absolute paths in them; Node's env-file parser does not expand `$HOME` or `~`. For launchd, move any repository-root `.env` to private storage, because the HTTP/backup entry points also load `.env` when one exists. A private env-file path is placed in the plist; token/password values are never embedded there.

The service plist sets `PATRICK_MODE=live`, loopback `PATRICK_HOST`, `PATRICK_CONFIG`, `PATRICK_DATA_DIR`, `PATRICK_VAULT_DIR=dataDir/vault` and `PATRICK_NETWORK_CONFIG` explicitly. Its environment takes precedence over conflicting values in an env-file. Keep project/runner/network JSON free of secrets. Runner policies remain unadmitted until provider, model, entitlement, cost, isolation and fallback evidence have passed.

## Generate, review, then load LaunchAgents

Replace the example absolute paths with authorized private locations. The output directory is supplied by the operator; no system location is inferred or installed:

```sh
node --import=tsx scripts/install-service.ts \
  --output-dir "/absolute/private/launchd-output" \
  --node "/absolute/path/to/node24/bin/node" \
  --repo-dir "$PWD" \
  --env-file "/absolute/private/service.env" \
  --backup-env-file "/absolute/private/backup.env" \
  --config "/absolute/private/patrick.config.json" \
  --data-dir "/absolute/private/PAtrick" \
  --network-config "/absolute/private/network.json"
```

The npm alias is `npm run install-service -- <arguments>`. Review the two generated plists and `INSTALL.md`, then run its explicit installation/bootstrap commands yourself. Existing output files are never overwritten. Paths with Chinese characters, spaces, quotes or ampersands are XML-escaped into individual `ProgramArguments`; launchd does not interpret them through a shell. The fixed PATH includes the resolved Node directory and normal Homebrew/system binary locations. Install approved tools there or adjust and re-review the generated PATH.

`com.patrick.workbench` runs the built `dist/index.js` with the repository as `WorkingDirectory`. Build after every source update while the job is stopped. The existing host performs its network check at startup and on a 60-second internal timer. A second network LaunchAgent or second database host would be incorrect. Shutdown uses SIGTERM and waits for durable work to stop and the writer lease to release.

`com.patrick.backup` runs `scripts/backup.ts` with the private backup environment daily at 03:15 local time. Keep `tsx` installed, because operational TypeScript scripts are not emitted into `dist`. Do not set a fixed reused `PATRICK_BACKUP_DIR`: each snapshot destination must be new; the default timestamped `dataDir/backups` path handles that. Logs are private under `dataDir/logs` unless `--log-dir` names another private location. Configure rotation through an approved host policy.

These are user LaunchAgents. They run while the account is logged in and continue after the IDE, browser and Obsidian close. They do not run before login or while the Mac is asleep/powered off. FileVault, power/wake policy and any requirement for a reviewed system LaunchDaemon need separate host acceptance. Check the job's last exit status and `/health`, stop it using the generated `launchctl bootout` commands, and confirm clean lease release before accepting unattended operation. No `launchctl` command is executed by the generator.

## Lima worker isolation

[examples/lima.yaml](../examples/lima.yaml) retains `minimumLimaVersion: 2.3.0` and requires macOS VZ support plus `networkOpts.hostLoopback` support. Stable/Homebrew **2.2.1** lacks that option; do not lower the minimum or remove isolation settings. The local trial used official development source pinned to [`f1f3cec7265175a7c1ced22cfc228ce4eb73aa96`](https://github.com/lima-vm/lima/tree/f1f3cec7265175a7c1ced22cfc228ce4eb73aa96), with its full SHA as version under the upstream development comparator. It is not a released 2.3 build. The repository example uses the Ubuntu 24.04 template, `plain: true`, no host mounts, no copied host SSH keys or forwarded agent, no dynamic application port forwarding, no proxy-environment propagation, and `networkOpts.hostLoopback: false`. Plain mode disables mount/agent conveniences inherited from a base template; `limactl shell` remains available. These settings follow the [official plain-mode documentation](https://lima-vm.io/docs/config/plain/) and [pinned official template reference](https://github.com/lima-vm/lima/blob/f1f3cec7265175a7c1ced22cfc228ce4eb73aa96/templates/default.yaml).

Select and review a build implementing the required option before validating the template without starting a VM. See the [official source-installation guide](https://lima-vm.io/docs/installation/source/) and [host-loopback documentation](https://lima-vm.io/docs/config/network/user/); a development build needs its own pinned provenance and validation. For a custom installation, the reviewed binary must be on the service PATH. Keep the chosen private instance store consistent across operator commands and the PAtrick process:

```sh
export LIMA_HOME="/absolute/private/path/lima"
```

Set that same absolute `LIMA_HOME` in the private service environment when using it. An unset variable retains Lima defaults. PAtrick forwards only host PATH/HOME/TMPDIR and optional `LIMA_HOME` to its shared CLI/ACP Lima transport; this does not forward arbitrary `LIMA_*`, proxies or credentials into the child environment. Review the generated launchd PATH separately for a private binary prefix. Then validate:

```sh
limactl --version
limactl validate examples/lima.yaml
```

For an explicitly authorized VM creation, the documented command is `limactl start --name=patrick examples/lima.yaml`; do not run it as part of plist generation. The CLI syntax is covered by the [official validation reference](https://lima-vm.io/docs/reference/limactl_validate/) and [start reference](https://lima-vm.io/docs/reference/limactl_start/). Review the installed build's resolved template and any `LIMA_HOME/_config/{default,override,base}.yaml`: global overrides can change isolation settings. Verify the actual guest has no host home/repository mounts and no `SSH_AUTH_SOCK`.

Install guest Node 24 and approved Grok/dsh/Codex CLIs through verified distribution channels. Authenticate those CLIs inside the guest under the permitted unattended-use terms. Current operator policy permits only existing included Grok/Codex subscription allowance with no additional billing; account entitlement and paid-overflow controls remain unverified and must pass before any real call. A local reservation does not authorize additional spending. Never provide host repository writer tokens, the service environment or a forwarded host agent. PAtrick sends bounded task material to a private guest `/tmp/patrick-*` workspace, then removes it. Verify cleanup and provider session-upload policies independently.

The YAML does **not** enforce an outbound allowlist. Host-loopback blocking also does not block the host's LAN address. Enforce approved guest/host firewall or gateway rules for the permitted model providers and business targets, deny host/enterprise networks by default, and prove denied traffic fails before admitting a runner. No firewall, CLI authentication or VM execution is established merely by writing the example. Keep `admitted: false` until these tests pass.

The **2026-11-04 current-MacBook trial** is a separate operational record: native Ubuntu 24.04.5 ARM64, 2 CPUs / 4 GiB RAM / 30 GiB disk, Node 24.22.2 and npm 11.19.1, in a dedicated reviewed home without global default/override/base files. A single official digest-pinned image was verified before boot; a private local image path replaced only its URL after download recovery, with no unpinned fallback. Actual mount/agent/SSH and host-loopback probes passed, and the compiled adapter exercised three synthetic-runner outcomes plus workspace cleanup. The default guest user can sudo; approved egress, unprivileged model execution, provider login/entitlement/billing/fallback, cancellation and offline cleanup remain unqualified. No production, launchd or full worker admission follows. The repository YAML remains an operator-reviewed starting point; private trial helpers are not repository commands. See [the bounded trial record](test-report.md#bounded-local-lima-trial-and-home-selection).

## Approved network paths and corporate prerequisites

[examples/network.json](../examples/network.json) matches the runtime Schema and the pilot's `personal` domain. It contains a local `/health` heartbeat and a deliberately unresolved `.invalid` egress target, with `UNCONFIGURED` Shortcuts names. Copy it to the private configured network path, then replace only with explicitly authorized URLs and verified Shortcuts. The unchanged example blocks personal work. A `domain` with no approved targets remains blocked.

The `status` Shortcut must print exactly `connected` or `disconnected`; `connect` and `disconnect` must be bounded, path-specific and reversible. Test their permission prompts and outputs manually before removing the placeholder names. The guardian serializes repair, applies retry limits/backoff, avoids reconnecting for 401/403, rate limits or MFA, and rechecks the failed path, previously healthy paths and heartbeat. A working HTTP probe alone does not prove a designated VPN or egress.

Corporate access is unconfigured: no intranet URL, DNS server, route, corporate adapter or corporate target is invented by this example. Before adding a corporate-domain target, record all of the following:

- Written authorization for the business URL, approved VPN profile and split-tunnel policy, plus actual Tunnelblick/OpenVPN or Shadowrocket commands/Shortcuts and their allowed privileges.
- Exact corporate DNS server addresses/suffixes as shown by `/usr/sbin/scutil --dns`, the intranet hostname's resolution, and the approved certificate/proxy configuration. Set nonempty `requiredDns` from that evidence.
- The expected route interface/gateway from `/sbin/route -n get <approved-host>`. Set `requiredRoute` to a verified identifying route string and `corporate: true` so missing DNS/routes block the probe.
- Both startup orders for any concurrently authorized VPNs, simultaneous business traffic, a one-path reconnect, and proof that corporate DNS/routes, personal GitHub egress and heartbeat all stay correct.
- Owner handling for authentication/MFA and a record of uncertain remote actions reconciled before queue resumption. Reconnection is not authorization repair.

Until that checklist passes, the corporate path is unready and must not be admitted. If concurrent tunnels are not approved, use separate authorized hosts or drain writes before an explicitly permitted switch. Installing a VPN application alone does not configure or accept the path.

## Daily backup and encrypted copy

The daily job uses SQLite's online backup API, verifies the complete manifest, records `workspace-mode`, and includes the consistent ledger plus published Markdown Vault/conflict versions. Machine leases, access tokens and private environment files are excluded. Non-Markdown attachments need a separate authorized backup policy. A local backup on the same disk is only one copy.

For the optional restic step, place `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` in the protected `backup.env`. Keep the password file owner-only and external to snapshots; initialize the approved restic repository separately. Do not put `RESTIC_PASSWORD` literals in the plist, commands, logs or repository. The script invokes restic only after snapshot integrity verification. With restic absent/unconfigured, encrypted off-machine backup is **unready**, even when the local snapshot succeeds. No repository initialization, password, remote authentication, retention/prune policy or restore acceptance is implied by the generated daily job.

## Offline restore and writer takeover

First stop the LaunchAgents and confirm the old writer has exited. On device handover, revoke the old writer's remote repository/chat credentials, obtain newly issued credentials externally, and reconcile the remote PR/head/merge/message effects against durable action IDs. The local SQLite lease is not a distributed lease between independent copied directories. Review current project/domain permissions and withdrawal records before resuming.

The restore command requires the operator's explicit assertions; it cannot perform those external steps or assert them automatically:

```sh
node --import=tsx scripts/restore.ts "/absolute/verified/snapshot" \
  --data-dir "/absolute/private/PAtrick" \
  --writer-revoked --reconciled
```

The npm alias is `npm run restore -- ...`. `--writer-revoked` means old remote writer credentials have actually been revoked. `--reconciled` means uncertain remote actions and current permissions have actually been reconciled. Do not supply either to bypass its prerequisite. The command refuses an active PID, malformed/unknown lease identity, or another host's SQLite lease. Never remove `writer.lock` or `host-lease.db` to force takeover.

Recovery verifies all manifest hashes and all files, rejects symlinks/unmanifested files and credential-bearing manifest paths, then verifies a staged copy on the same filesystem. It restores only `patrick.db`, `workspace-mode` and published Vault Markdown files. It opens the staged Store before use, replaying withdrawal tombstones and rebuilding FTS/Vault, so a stale card cannot resurrect withdrawn evidence. Snapshot mode is required and retained: demo/test data does not become live data, and known demo evidence in a live-labelled snapshot is refused. Older snapshots without a verified mode require a new properly labelled backup rather than a guessed live mode.

The whole stopped data directory is swapped with sibling renames. The previous directory is retained as `PAtrick.previous-<timestamp>-<suffix>`; an interruption between renames leaves it available for operator recovery. The new directory carries the restore process's live lease during the swap. No snapshot credentials are restored, and the previous token remains only in the retained old directory. Use a newly issued private `PATRICK_TOKEN`/writer credentials, or let live bootstrap generate a new local access token. Do not reuse an old machine token by copying it back.

The command starts no service and sends no remote messages. The automated swap assumes `dataDir/vault`; a separately configured external Vault needs a coordinated, stopped manual recovery. Run a restore drill in an isolated temporary directory, check withdrawn-marker absence in lookup and Markdown, compare remote action IDs without replaying writes, and check the newly issued credentials before bootstrapping the service. Retain the previous directory until the drill and current permission checks are accepted.

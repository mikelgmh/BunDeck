# Windows launcher performance smoke

`Invoke-LauncherPerformance.ps1` measures a supplied Windows launcher without
building or installing BunDeck. It copies the executable into a GUID-named
temporary install tree, redirects its data/profile directories, assigns
currently-free loopback ports, starts only that copy, and samples that owned
process.

The default run is informational: it reports measurements but applies no
performance budget. Threshold checks are opt-in through command-line
parameters.

## Prerequisites

- Windows 10/11, PowerShell 5.1 or later, and an interactive desktop session.
- A built Windows launcher executable. The harness does not build one.
- Permission to read process CPU/working-set data and enumerate top-level
  windows in the current desktop session.
- No BunDeck launcher running in the same Windows session. The launcher uses
  the session-wide `Local\BunDeck.Launcher.SingleInstance` mutex; the harness
  checks for it and refuses to start if it is already present.

## Run

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher\tests\performance\Invoke-LauncherPerformance.ps1 `
  -LauncherExe .\path\to\bundeck-launcher.exe
```

Sampling and optional budgets:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher\tests\performance\Invoke-LauncherPerformance.ps1 `
  -LauncherExe .\path\to\bundeck-launcher.exe `
  -SamplingSeconds 30 -SampleIntervalMilliseconds 500 -WarmupSeconds 5 `
  -MaxStartupToWindowMs 5000 -MaxAverageCpuPercent 1.0 -MaxWorkingSetMiB 250
```

Available controls:

- `-SamplingSeconds` (default 15): idle metric interval.
- `-SampleIntervalMilliseconds` (default 500): working-set sample cadence.
- `-WarmupSeconds` (default 15): settling time after startup/window detection,
  intended to let first-run probes complete before the idle sample.
- `-WindowTimeoutSeconds` (default 45): maximum wait for a visible window.
- `-MaxStartupToWindowMs`, `-MaxAverageCpuPercent`, and `-MaxWorkingSetMiB`:
  optional thresholds. Any supplied threshold that cannot be measured is
  reported as not evaluated, and the script exits nonzero.
- `-KeepArtifacts`: retain the isolated temporary tree for diagnostics.

The CPU time delta is divided by wall-clock sampling time and logical processor
count for normalized average CPU percentage. The report also includes CPU as
percent of one logical CPU, plus minimum/average/maximum sampled working set.
Working set is memory currently resident for the launcher process, not private
bytes or total system memory.

## Safety and interpretation

- The supplied executable is copied to a fresh temporary install directory.
  `APPDATA`, `LOCALAPPDATA`, `BUNDECK_DATA_DIR`, and
  `BUNDECK_INSTALL_DIR` point only into that directory tree. The app's
  instance-metadata path is therefore isolated too.
- Four random loopback ports are assigned to API, WS, frontend, and host probes.
  Selection briefly binds sockets; a port could theoretically be claimed by
  another process immediately afterward.
- The harness refuses to start if the session-wide launcher mutex is present.
  If another launcher races with the check, the test copy sees the mutex but
  has no access to the real install's metadata (its `LOCALAPPDATA` is isolated);
  the application fails closed rather than terminating the existing launcher.
- Cleanup only calls `Kill()` on the `Process` object returned by this run's
  `Process.Start`, after checking both its PID and start time. It never kills
  by image name, enumerates processes to stop, kills a process tree, or sends
  daemon shutdown requests. No daemon is copied beside the launcher, and the
  current working directory is the isolated install.
- Startup-to-window latency is measured from just before process creation to
  the first visible, non-zero-size top-level Win32 window owned by the spawned
  PID. This confirms window creation, not completed GPUI rendering or
  interactive readiness. If no such window is seen, the script reports the
  latency as unavailable instead of substituting a process-start timestamp.
- The isolated launcher does not have a daemon beside it, so its probes see
  services as down; its idle CPU and memory are not a connected-daemon
  workload. `DEV_MODE=true` disables automatic update downloads, but current
  startup code still makes a read-only GitHub latest-release request once.
  Network conditions can therefore affect first-start timing and should be
  recorded when comparing runs.
- These measurements are best treated as same-machine before/after smoke
  signals. Close unrelated workloads, keep power mode/display state consistent,
  and compare repeated runs; do not use a single run as a release-quality
  benchmark.

## Performance review: current Rust paths

This is a source review, not a benchmark result.

- **UI polling and redraws — `launcher/src/main.rs:511-665`:** a GPUI task wakes
  every 250 ms, drains background events, checks updater state, truncates the
  log, and calls `cx.notify()` each pass. That is up to four notifications per
  second while idle. Useful follow-up: profile UI-thread CPU and frame/update
  counts with the window visible, then compare notifying only when state
  changes. The present harness's process CPU number can expose a regression,
  but cannot isolate GPUI rendering from background work.
- **Monitor loop — `launcher/src/main.rs:1149-1238` and
  `launcher/src/monitor.rs:89-205`:** each monitor cycle runs service checks
  sequentially and then waits up to two more seconds on the command channel.
  API, WS, and frontend probes have individual timeouts; frontend can try both
  Astro and configured ports, and its HEAD fallback can issue GET too.
  Additional version, Spotify, autostart, and first-run GitHub calls add work.
  A disconnected service can therefore make cycles materially longer than the
  nominal two-second wait. Meaningful workloads: connected local services,
  all services down, and one/two slow probes; measure cycle duration and
  command-to-visible-state latency.
- **Locks — `launcher/src/main.rs:374`, `:533-580`, `:1047-1073` and
  `launcher/src/updater.rs:553-683`:** the shared update-progress mutex is
  sampled by the UI and updated by the worker, including once per 64 KiB
  download chunk. Critical sections mostly copy/update small fields, so idle
  contention is likely small; large/fast local downloads are the meaningful
  stress case. Track lock wait/hold time and UI responsiveness during that
  workload before changing synchronization.
- **Updater hashing and extraction — `launcher/src/updater.rs:512-529`,
  `:553-659`, `:686-709`:** SHA-256 verification reads 64 KiB blocks and ZIP
  extraction iterates entries, creates parent directories/files, and copies
  contents. Benchmark hash throughput separately from extraction throughput
  and full stage wall time using representative bundle sizes, both warm and
  cold cache. Run only against a disposable install/data fixture; this smoke
  harness intentionally does not invoke updater operations.
- **Monitor/tray intervals — `launcher/src/main.rs:521-522`, `:1238-1255`,
  and `launcher/src/tray.rs:1-11`:** the UI event drain is 250 ms, service
  monitoring waits two seconds after each pass, and tray events are polled by
  the anchor at about 100 ms. Benchmark idle CPU at these settings and measure
  tray-action latency before considering longer intervals; cadence changes
  trade responsiveness for wakeups.

## Opt-in Rust updater throughput benchmarks

Two ignored unit tests in `launcher/src/updater.rs` measure SHA-256 verification
and ZIP extraction using generated fixtures in unique temporary directories.
They print elapsed time and throughput, make no timing assertions, and remove
their fixtures on completion (including unwinding). The SHA fixture is 128 MiB;
the ZIP fixture is 32 stored entries totaling 128 MiB uncompressed.

From the repository root, run both in release mode:

```powershell
cargo test --release --locked --manifest-path launcher/Cargo.toml updater::tests::benchmark_ -- --ignored --nocapture
```

The tests intentionally use the warm filesystem cache: fixtures are written
immediately before the timed read/extraction, and portable cache eviction is
not attempted. SHA throughput includes filesystem reads and hashing. ZIP
throughput includes archive reads, directory/file creation, and extracted file
writes; stored entries avoid measuring DEFLATE decompression. Results are
machine/storage/cache dependent and are diagnostic only, not release gates.

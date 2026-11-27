# Windows launcher E2E harness

`Invoke-LauncherE2E.ps1` runs a supplied Windows launcher executable from a
fresh temporary install tree. It does **not** build or install BunDeck and
never uses the normal BunDeck profile. The script copies the supplied EXE,
redirects `APPDATA`, `LOCALAPPDATA`, and `BUNDECK_DATA_DIR` to a unique temp
directory, and assigns three currently-free loopback ports. It starts no
daemon and disables automatic update checks with `DEV_MODE=true`.

## Prerequisites

- Windows 10/11 with an interactive desktop session and Explorer running.
- PowerShell 5.1 or later.
- A built Windows `bundeck-launcher.exe` (prefer the release executable
  from a package/layout you want to verify). This harness does not build one.
- An interactive desktop session for the duplicate-launch prompts. The
  harness uses UI Automation when available and a process-scoped Win32 button
  fallback otherwise. Tray checkpoints are manual because notification-area
  automation differs across Windows/Explorer versions.

## Run

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher\tests\e2e\Invoke-LauncherE2E.ps1 `
  -LauncherExe .\launcher\target\release\bundeck-launcher.exe
```

The test launches the copied EXE and verifies its visible panel. A second copy
exercises the duplicate prompt and chooses **No**. A third copy exercises the
affirmative replacement flow: the harness verifies the prompt names its
tracked first process before choosing **Yes/Sí**, then checks that the old
process exited and the replacement owns the visible panel. It then asks the
operator to close the panel with its X, reopen it from the tray, and choose
**Salir**. Process checks use the handles returned for this run's launches.

For a non-interactive smoke test that only verifies process launch and the
visible panel:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher\tests\e2e\Invoke-LauncherE2E.ps1 `
  -LauncherExe .\path\to\libredeck-launcher.exe -SmokeOnly
```

To test both duplicate-instance choices automatically, but skip the
operator-driven tray checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launcher\tests\e2e\Invoke-LauncherE2E.ps1 `
  -LauncherExe .\path\to\libredeck-launcher.exe -SkipTrayChecks
```

Use `-KeepArtifacts` to preserve the script's unique temp directory for
diagnostics. Otherwise it is removed on completion.

## Safety and limits

- The harness never invokes `taskkill`, kills by image name, closes a
  pre-existing BunDeck instance, or sends shutdown requests to a server. For
  the affirmative test, the launcher performs its normal replacement action
  only after the harness confirms the prompt PID and isolated instance
  metadata match the still-running, harness-owned first process.
- If an unrelated launcher already owns the session mutex at startup, the
  harness refuses to answer its prompt and stops without attempting
  replacement.
- The install/data/profile paths are new GUID-named directories below the
  current user's temp directory; they are not the real application profile.
- Port selection briefly binds loopback sockets to choose unused ports; as
  with any free-port selection, another process could claim one immediately
  afterward.
- Tray icon presence, close-to-tray, click-to-reopen, and tray Quit are
  deliberately operator-driven. The script checks visible windows and
  liveness before/after each action but does not claim to automate Explorer's
  tray UI.
- Use a standalone release/package executable. A development build may show
  a console or may not represent the installed layout. Since the launcher
  copy is placed in an empty temporary install directory, it cannot discover
  repository daemon sources or a neighboring installed daemon.

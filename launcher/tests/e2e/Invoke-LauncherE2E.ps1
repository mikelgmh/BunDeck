[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $LauncherExe,

    [switch] $SmokeOnly,

    [switch] $SkipTrayChecks,

    [ValidateRange(10, 180)]
    [int] $TimeoutSeconds = 40,

    [switch] $KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This harness only runs on Windows.'
}

$sourceExe = (Resolve-Path -LiteralPath $LauncherExe).Path
if ([IO.Path]::GetExtension($sourceExe) -ne '.exe') {
    throw "-LauncherExe must point to a Windows .exe: $sourceExe"
}

if (-not ('BunDeckE2E.NativeWindows' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace BunDeckE2E {
    public sealed class WindowInfo {
        public IntPtr Handle { get; set; }
        public string Title { get; set; }
        public string ClassName { get; set; }
    }

    public static class NativeWindows {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);
        [DllImport("user32.dll")]
        private static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        public static bool IsDuplicatePromptTitle(string title) {
            return title != null
                && title.StartsWith("BunDeck ya est", StringComparison.OrdinalIgnoreCase)
                && title.EndsWith("abierto", StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsAffirmativeButtonLabel(string label) {
            return IsButtonLabel(label, new[] {
                "Yes", "S\u00ED", "Si", "\u662F", "\u306F\u3044", "Ja", "Oui", "Sim",
                "\u0414\u0430", "\u0646\u0639\u0645", "Tak", "J\u0101", "Evet", "Igen", "Ano"
            });
        }

        public static bool IsNegativeButtonLabel(string label) {
            return IsButtonLabel(label, new[] {
                "No", "\u5426", "\u3044\u3044\u3048", "Nein", "Non", "Nej", "N\u00E3o",
                "\u041D\u0435\u0442", "\u0644\u0627", "Nei"
            });
        }

        private static bool IsButtonLabel(string label, string[] labels) {
            if (label == null)
                return false;
            string normalized = label.Trim().Replace("&", "").Trim();
            foreach (string candidate in labels) {
                if (String.Equals(normalized, candidate, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        public static bool HasDuplicatePrompt(uint targetPid) {
            bool found = false;
            EnumWindows((hwnd, _) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != targetPid || !IsWindowVisible(hwnd))
                    return true;
                int length = GetWindowTextLength(hwnd);
                var title = new StringBuilder(Math.Max(length + 1, 2));
                GetWindowText(hwnd, title, title.Capacity);
                found = IsDuplicatePromptTitle(title.ToString());
                return !found;
            }, IntPtr.Zero);
            return found;
        }

        public static bool DuplicatePromptMentionsPid(uint dialogPid, uint ownerPid) {
            bool found = false;
            string expected = "PID " + ownerPid.ToString();
            EnumWindows((hwnd, _) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != dialogPid || !IsWindowVisible(hwnd))
                    return true;
                int length = GetWindowTextLength(hwnd);
                var title = new StringBuilder(Math.Max(length + 1, 2));
                GetWindowText(hwnd, title, title.Capacity);
                if (!IsDuplicatePromptTitle(title.ToString()))
                    return true;

                EnumChildWindows(hwnd, (child, __) => {
                    int childLength = GetWindowTextLength(child);
                    var text = new StringBuilder(Math.Max(childLength + 1, 2));
                    GetWindowText(child, text, text.Capacity);
                    if (text.ToString().IndexOf(expected, StringComparison.OrdinalIgnoreCase) >= 0) {
                        found = true;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
                return !found;
            }, IntPtr.Zero);
            return found;
        }

        public static string[] DuplicatePromptButtonLabels(uint targetPid) {
            var labels = new List<string>();
            EnumWindows((hwnd, _) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != targetPid || !IsWindowVisible(hwnd))
                    return true;
                int length = GetWindowTextLength(hwnd);
                var title = new StringBuilder(Math.Max(length + 1, 2));
                GetWindowText(hwnd, title, title.Capacity);
                if (!IsDuplicatePromptTitle(title.ToString()))
                    return true;

                EnumChildWindows(hwnd, (child, __) => {
                    var className = new StringBuilder(64);
                    GetClassName(child, className, className.Capacity);
                    if (className.ToString() == "Button") {
                        int buttonLength = GetWindowTextLength(child);
                        var text = new StringBuilder(Math.Max(buttonLength + 1, 2));
                        GetWindowText(child, text, text.Capacity);
                        labels.Add(text.ToString());
                    }
                    return true;
                }, IntPtr.Zero);
                return true;
            }, IntPtr.Zero);
            return labels.ToArray();
        }

        public static WindowInfo[] VisibleWindows(uint targetPid) {
            var windows = new List<WindowInfo>();
            EnumWindows((hwnd, _) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid == targetPid && IsWindowVisible(hwnd)) {
                    int length = GetWindowTextLength(hwnd);
                    var title = new StringBuilder(Math.Max(length + 1, 2));
                    GetWindowText(hwnd, title, title.Capacity);
                    if (title.Length > 0) {
                        var className = new StringBuilder(128);
                        GetClassName(hwnd, className, className.Capacity);
                        windows.Add(new WindowInfo {
                            Handle = hwnd,
                            Title = title.ToString(),
                            ClassName = className.ToString()
                        });
                    }
                }
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        }

        public static bool ClickDuplicatePromptButton(uint targetPid, bool affirmative) {
            bool clicked = false;
            EnumWindows((hwnd, _) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != targetPid || !IsWindowVisible(hwnd))
                    return true;

                int length = GetWindowTextLength(hwnd);
                var title = new StringBuilder(Math.Max(length + 1, 2));
                GetWindowText(hwnd, title, title.Capacity);
                if (!IsDuplicatePromptTitle(title.ToString()))
                    return true;

                EnumChildWindows(hwnd, (child, __) => {
                    var className = new StringBuilder(64);
                    GetClassName(child, className, className.Capacity);
                    if (className.ToString() != "Button")
                        return true;

                    int buttonLength = GetWindowTextLength(child);
                    var buttonText = new StringBuilder(Math.Max(buttonLength + 1, 2));
                    GetWindowText(child, buttonText, buttonText.Capacity);
                    string name = buttonText.ToString();
                    bool matches = affirmative
                        ? IsAffirmativeButtonLabel(name)
                        : IsNegativeButtonLabel(name);
                    if (matches) {
                        SendMessage(child, 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK
                        clicked = true;
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);
                return !clicked;
            }, IntPtr.Zero);
            return clicked;
        }
    }
}
'@
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("BunDeckLauncherE2E-" + [guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'install'
$dataDir = Join-Path $testRoot 'data'
$roamingDir = Join-Path $testRoot 'roaming'
$localDir = Join-Path $testRoot 'local'
$launcherCopy = Join-Path $installDir 'bundeck-launcher.exe'
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$testFailed = $false

function Get-FreeLocalPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint] $listener.LocalEndpoint).Port
    }
    finally {
        $listener.Stop()
    }
}

function Get-LauncherWindows([Diagnostics.Process] $Process) {
    if ($Process.HasExited) { return @() }
    return @([BunDeckE2E.NativeWindows]::VisibleWindows([uint32] $Process.Id) |
        Where-Object {
            $_.Title -like '*BunDeck*' -and
            $_.ClassName -ne '#32770' -and
            -not [BunDeckE2E.NativeWindows]::IsDuplicatePromptTitle($_.Title)
        })
}

function Get-UnexpectedLauncherDialogs([Diagnostics.Process] $Process) {
    if ($Process.HasExited) { return @() }
    return @([BunDeckE2E.NativeWindows]::VisibleWindows([uint32] $Process.Id) |
        Where-Object {
            $_.ClassName -eq '#32770' -and
            -not [BunDeckE2E.NativeWindows]::IsDuplicatePromptTitle($_.Title)
        })
}

function Wait-LauncherWindow([Diagnostics.Process] $Process, [bool] $Visible, [string] $Description) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $windows = @(Get-LauncherWindows $Process)
        if (($Visible -and $windows.Count -gt 0) -or (-not $Visible -and $windows.Count -eq 0)) {
            return $windows
        }
        if ($Process.HasExited) {
            throw "Launcher PID $($Process.Id) exited while waiting for $Description (exit code $($Process.ExitCode))."
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for $Description for launcher PID $($Process.Id)."
}

function Wait-InitialLauncherPanel([Diagnostics.Process] $Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($Process.HasExited) {
            throw "Initial test launcher exited before showing its panel (exit code $($Process.ExitCode))."
        }
        $windows = @(Get-LauncherWindows $Process)
        if ($windows.Count -gt 0) { return $windows }
        if ([BunDeckE2E.NativeWindows]::HasDuplicatePrompt([uint32] $Process.Id)) {
            throw 'The session mutex is already held by another launcher. Refusing to answer its prompt; no replacement was attempted.'
        }
        $unexpectedDialogs = @(Get-UnexpectedLauncherDialogs $Process)
        if ($unexpectedDialogs.Count -gt 0) {
            throw "Initial launcher showed an unexpected dialog '$($unexpectedDialogs[0].Title)'. Refusing interaction because mutex ownership could not be confirmed."
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Timed out waiting for the initial test launcher panel.'
}

function Get-TestInstanceOwnerPid {
    $metadataDir = Join-Path $localDir 'BunDeck'
    $metadataFiles = @(Get-ChildItem -LiteralPath $metadataDir -Filter 'instance-*.txt' -File -ErrorAction Stop)
    if ($metadataFiles.Count -ne 1) {
        throw "Expected one instance metadata file in the harness-owned directory; found $($metadataFiles.Count)."
    }
    $pidText = (Get-Content -LiteralPath $metadataFiles[0].FullName -TotalCount 1).Trim()
    $ownerPid = 0
    if (-not [uint32]::TryParse($pidText, [ref] $ownerPid)) {
        throw 'Harness-owned instance metadata did not contain a valid PID.'
    }
    return [uint32] $ownerPid
}

function Start-OwnedLauncher {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $launcherCopy
    $info.WorkingDirectory = $installDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true

    # All mutable state and instance metadata are redirected into this run's
    # unique temporary tree. Unique ports prevent touching an existing server.
    $info.EnvironmentVariables['APPDATA'] = $roamingDir
    $info.EnvironmentVariables['LOCALAPPDATA'] = $localDir
    $info.EnvironmentVariables['BUNDECK_DATA_DIR'] = $dataDir
    $info.EnvironmentVariables['DEV_MODE'] = 'true'
    $info.EnvironmentVariables['PORT'] = [string] (Get-FreeLocalPort)
    $info.EnvironmentVariables['WS_PORT'] = [string] (Get-FreeLocalPort)
    $info.EnvironmentVariables['FRONTEND_PORT'] = [string] (Get-FreeLocalPort)

    $process = [Diagnostics.Process]::Start($info)
    if ($null -eq $process) { throw 'Windows did not return a process handle.' }
    $ownedProcesses.Add($process)
    return $process
}

function Assert-ProcessAlive([Diagnostics.Process] $Process, [string] $Message) {
    $Process.Refresh()
    if ($Process.HasExited) {
        throw "$Message (PID $($Process.Id) exited with code $($Process.ExitCode))."
    }
}

try {
    New-Item -ItemType Directory -Path $installDir, $dataDir, $roamingDir, $localDir -Force | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination $launcherCopy

    Write-Host "Disposable test root: $testRoot"
    Write-Host 'Launching the supplied executable copy with isolated profile data and ports...'
    $primary = Start-OwnedLauncher
    $null = Wait-InitialLauncherPanel $primary
    Write-Host "PASS: visible panel found for owned process PID $($primary.Id)."
    $activeLauncher = $primary

    if ($SmokeOnly) {
        Write-Host 'SMOKE ONLY: duplicate-launch and tray interactions were not exercised.'
    }
    else {
        # The process owns the isolated mutex metadata, so this second copy can
        # only encounter the first test process, never a normal profile instance.
        Write-Host 'Starting a second isolated copy to exercise the duplicate-instance prompt...'
        $duplicate = Start-OwnedLauncher

        $uiaAvailable = $true
        try {
            Add-Type -AssemblyName UIAutomationClient
            Add-Type -AssemblyName UIAutomationTypes
        }
        catch {
            $uiaAvailable = $false
            Write-Warning "UI Automation assemblies unavailable; using the scoped Win32 dialog fallback. $($_.Exception.Message)"
        }

        $dialogHandled = $false
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline -and -not $dialogHandled) {
            if ($duplicate.HasExited) {
                throw "Duplicate launcher exited before its prompt could be verified (exit code $($duplicate.ExitCode))."
            }
            $unexpectedDialogs = @(Get-UnexpectedLauncherDialogs $duplicate)
            if ($unexpectedDialogs.Count -gt 0) {
                throw "Duplicate process showed an unexpected dialog '$($unexpectedDialogs[0].Title)'; refusing interaction."
            }
            $duplicateWindows = @(Get-LauncherWindows $duplicate)
            if ($duplicateWindows.Count -gt 0) {
                $titles = ($duplicateWindows | ForEach-Object { $_.Title }) -join ' | '
                throw "The second process opened a panel instead of showing the duplicate-instance prompt. The supplied EXE may be stale or lack the current single-instance behavior. Visible windows: $titles"
            }
            if ([BunDeckE2E.NativeWindows]::ClickDuplicatePromptButton([uint32] $duplicate.Id, $false)) {
                $dialogHandled = $true
            }
            if (-not $dialogHandled -and $uiaAvailable) {
                try {
                    $root = [Windows.Automation.AutomationElement]::RootElement
                    $condition = [Windows.Automation.PropertyCondition]::new(
                        [Windows.Automation.AutomationElement]::ProcessIdProperty,
                        $duplicate.Id
                    )
                    $windows = $root.FindAll([Windows.Automation.TreeScope]::Children, $condition)
                    foreach ($window in $windows) {
                        if ([BunDeckE2E.NativeWindows]::IsDuplicatePromptTitle($window.Current.Name)) {
                            $buttons = $window.FindAll(
                                [Windows.Automation.TreeScope]::Descendants,
                                [Windows.Automation.Condition]::TrueCondition
                            )
                            foreach ($button in $buttons) {
                                if ($button.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and
                                    [BunDeckE2E.NativeWindows]::IsNegativeButtonLabel($button.Current.Name)) {
                                    $invoke = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
                                    $invoke.Invoke()
                                    $dialogHandled = $true
                                    break
                                }
                            }
                        }
                    }
                }
                catch {
                    # The modal dialog may be changing UIA trees during creation.
                }
            }
            if (-not $dialogHandled) { Start-Sleep -Milliseconds 300 }
        }
        if (-not $dialogHandled) {
            $titles = @([BunDeckE2E.NativeWindows]::VisibleWindows([uint32] $duplicate.Id) |
                ForEach-Object { $_.Title })
            throw "Could not safely find and choose No on the duplicate-instance prompt. Visible windows for its PID: $($titles -join ' | ')"
        }

        $duplicate.WaitForExit($TimeoutSeconds * 1000) | Out-Null
        if (-not $duplicate.HasExited) {
            throw 'Duplicate launcher did not exit after choosing No.'
        }
        Assert-ProcessAlive $primary 'The original test launcher did not survive the duplicate-launch check'
        $null = Wait-LauncherWindow $primary $true 'the original panel after duplicate launch'
        Write-Host 'PASS: duplicate prompt was dismissed with No; only the original test process remained.'

        $ownerPid = Get-TestInstanceOwnerPid
        if ($ownerPid -ne [uint32] $primary.Id) {
            throw "Refusing affirmative replacement: the harness metadata names PID $ownerPid, not tracked primary PID $($primary.Id)."
        }

        Write-Host "Starting a third copy to replace harness-owned launcher PID $($primary.Id)..."
        $replacement = Start-OwnedLauncher
        $replacementDialogHandled = $false
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        while ([DateTime]::UtcNow -lt $deadline -and -not $replacementDialogHandled) {
            if ($replacement.HasExited) {
                throw "Replacement launcher exited before its prompt was handled (exit code $($replacement.ExitCode))."
            }
            $unexpectedDialogs = @(Get-UnexpectedLauncherDialogs $replacement)
            if ($unexpectedDialogs.Count -gt 0) {
                throw "Replacement process showed an unexpected dialog '$($unexpectedDialogs[0].Title)'; refusing affirmative action."
            }
            $replacementWindows = @(Get-LauncherWindows $replacement)
            if ($replacementWindows.Count -gt 0) {
                $titles = ($replacementWindows | ForEach-Object { $_.Title }) -join ' | '
                throw "Replacement process opened a panel without a replacement prompt. Refusing to continue. Visible windows: $titles"
            }

            if ([BunDeckE2E.NativeWindows]::HasDuplicatePrompt([uint32] $replacement.Id)) {
                Assert-ProcessAlive $primary 'Refusing affirmative replacement because the tracked older launcher is no longer alive'
                $currentOwnerPid = Get-TestInstanceOwnerPid
                if ($currentOwnerPid -ne [uint32] $primary.Id) {
                    throw "Refusing affirmative replacement: instance metadata now names PID $currentOwnerPid, not tracked primary PID $($primary.Id)."
                }
                if (-not [BunDeckE2E.NativeWindows]::DuplicatePromptMentionsPid(
                    [uint32] $replacement.Id,
                    [uint32] $primary.Id
                )) {
                    throw "Refusing affirmative replacement: the dialog does not identify tracked harness PID $($primary.Id) as the older instance."
                }

                if ([BunDeckE2E.NativeWindows]::ClickDuplicatePromptButton([uint32] $replacement.Id, $true)) {
                    $replacementDialogHandled = $true
                }
                elseif ($uiaAvailable) {
                    try {
                        $root = [Windows.Automation.AutomationElement]::RootElement
                        $condition = [Windows.Automation.PropertyCondition]::new(
                            [Windows.Automation.AutomationElement]::ProcessIdProperty,
                            $replacement.Id
                        )
                        $windows = $root.FindAll([Windows.Automation.TreeScope]::Children, $condition)
                        foreach ($window in $windows) {
                            if ([BunDeckE2E.NativeWindows]::IsDuplicatePromptTitle($window.Current.Name)) {
                                $buttons = $window.FindAll(
                                    [Windows.Automation.TreeScope]::Descendants,
                                    [Windows.Automation.Condition]::TrueCondition
                                )
                                foreach ($button in $buttons) {
                                    if ($button.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and
                                        [BunDeckE2E.NativeWindows]::IsAffirmativeButtonLabel($button.Current.Name)) {
                                        # Recheck the tracked owner immediately before invoking Yes/Sí.
                                        Assert-ProcessAlive $primary 'Refusing affirmative replacement because the tracked older launcher exited'
                                        if ((Get-TestInstanceOwnerPid) -ne [uint32] $primary.Id) {
                                            throw 'Refusing affirmative replacement because instance metadata changed.'
                                        }
                                        $invoke = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
                                        $invoke.Invoke()
                                        $replacementDialogHandled = $true
                                        break
                                    }
                                }
                            }
                        }
                    }
                    catch {
                        if ($replacementDialogHandled) { throw }
                        # The modal UIA tree may still be materializing; retry only while
                        # the known prompt and tracked owner remain in place.
                    }
                }
            }
            if (-not $replacementDialogHandled) { Start-Sleep -Milliseconds 300 }
        }
        if (-not $replacementDialogHandled) {
            $buttonLabels = @([BunDeckE2E.NativeWindows]::DuplicatePromptButtonLabels([uint32] $replacement.Id))
            throw "Could not safely find and choose the affirmative replacement button. Visible dialog button labels: $($buttonLabels -join ' | ')"
        }

        if (-not $primary.WaitForExit($TimeoutSeconds * 1000)) {
            throw "Older harness-owned launcher PID $($primary.Id) did not exit after affirmative replacement."
        }
        Assert-ProcessAlive $replacement 'Replacement launcher did not remain alive after the affirmative flow'
        $null = Wait-LauncherWindow $replacement $true 'the replacement launcher panel'
        $replacementOwnerPid = Get-TestInstanceOwnerPid
        if ($replacementOwnerPid -ne [uint32] $replacement.Id) {
            throw "Replacement panel is visible but harness metadata names PID $replacementOwnerPid instead of $($replacement.Id)."
        }
        $activeLauncher = $replacement
        Write-Host "PASS: Yes/Sí replaced owned PID $($primary.Id); replacement PID $($replacement.Id) owns the visible panel."

        if ($SkipTrayChecks) {
            Write-Host 'TRAY CHECKS SKIPPED: duplicate No and affirmative replacement were tested; close/reopen/quit were not.'
        }
        else {
            Write-Host ''
            Write-Host 'MANUAL TRAY CHECK 1/3: Confirm the BunDeck tray icon is present (including the overflow area if needed).'
            Read-Host 'Then close the visible panel with its X and press Enter here'
            $null = Wait-LauncherWindow $activeLauncher $false 'the panel to hide after its close button was used'
            Assert-ProcessAlive $activeLauncher 'The launcher should remain alive after closing its panel'
            Write-Host 'PASS: panel hidden while the owned launcher process stayed alive.'

            Write-Host 'MANUAL TRAY CHECK 2/3: Left-click the BunDeck tray icon to reopen the panel.'
            Read-Host 'After the panel is visible again, press Enter here'
            $null = Wait-LauncherWindow $activeLauncher $true 'the panel to reopen from the tray'
            Write-Host 'PASS: panel reopened from the tray.'

            Write-Host 'MANUAL TRAY CHECK 3/3: Right-click the tray icon and choose “Salir”.'
            Read-Host 'After the launcher exits, press Enter here'
            if (-not $activeLauncher.WaitForExit($TimeoutSeconds * 1000)) {
                throw 'The launcher remained alive after choosing Salir from the tray menu.'
            }
            Write-Host 'PASS: tray Quit exited the owned launcher process.'
        }
    }
}
catch {
    $testFailed = $true
    Write-Host "FAIL: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    # Only process handles returned by this script are ever stopped. There is
    # no name-based taskkill, process enumeration kill, or daemon shutdown call.
    foreach ($process in $ownedProcesses) {
        try {
            $process.Refresh()
            if (-not $process.HasExited) {
                $process.Kill()
                $null = $process.WaitForExit(5000)
            }
        }
        catch {
            Write-Warning "Could not stop test-owned process handle for PID $($process.Id): $($_.Exception.Message)"
        }
        finally {
            $process.Dispose()
        }
    }

    if ($KeepArtifacts) {
        Write-Host "Kept disposable test files at: $testRoot"
    }
    elseif (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

if ($testFailed) { exit 1 }
Write-Host 'Launcher E2E harness completed successfully.'

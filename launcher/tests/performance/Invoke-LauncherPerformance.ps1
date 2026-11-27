[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $LauncherExe,

    [ValidateRange(1, 600)]
    [int] $SamplingSeconds = 15,

    [ValidateRange(100, 10000)]
    [int] $SampleIntervalMilliseconds = 500,

    [ValidateRange(0, 120)]
    [int] $WarmupSeconds = 15,

    [ValidateRange(1, 180)]
    [int] $WindowTimeoutSeconds = 45,

    [ValidateRange(1, 1000000)]
    [double] $MaxStartupToWindowMs,

    [ValidateRange(0, 100)]
    [double] $MaxAverageCpuPercent,

    [ValidateRange(1, 1048576)]
    [double] $MaxWorkingSetMiB,

    [switch] $KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This performance harness only runs on Windows.'
}

$sourceExe = (Resolve-Path -LiteralPath $LauncherExe).Path
if ([IO.Path]::GetExtension($sourceExe) -ne '.exe') {
    throw "-LauncherExe must point to a Windows .exe: $sourceExe"
}

if (-not ('BunDeckPerformance.NativeWindows' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace BunDeckPerformance {
    public sealed class WindowInfo {
        public IntPtr Handle { get; set; }
        public string Title { get; set; }
    }

    public static class NativeWindows {
        private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")]
        private static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

        public static WindowInfo[] VisibleTopLevelWindows(uint targetPid) {
            var windows = new List<WindowInfo>();
            EnumWindows((hwnd, _) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != targetPid || !IsWindowVisible(hwnd))
                    return true;

                RECT rect;
                if (!GetWindowRect(hwnd, out rect) ||
                    rect.Right <= rect.Left || rect.Bottom <= rect.Top)
                    return true;

                int length = GetWindowTextLength(hwnd);
                var title = new StringBuilder(Math.Max(length + 1, 2));
                GetWindowText(hwnd, title, title.Capacity);
                windows.Add(new WindowInfo { Handle = hwnd, Title = title.ToString() });
                return true;
            }, IntPtr.Zero);
            return windows.ToArray();
        }
    }

    public static class InstanceMutex {
        private const uint SYNCHRONIZE = 0x00100000;
        private const int ERROR_FILE_NOT_FOUND = 2;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr OpenMutex(uint desiredAccess, bool inheritHandle, string name);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        // Returns false only when the mutex is absent. Other errors fail closed.
        public static bool IsPresent(string name) {
            IntPtr handle = OpenMutex(SYNCHRONIZE, false, name);
            if (handle != IntPtr.Zero) {
                CloseHandle(handle);
                return true;
            }
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_FILE_NOT_FOUND)
                return false;
            throw new InvalidOperationException(
                "Could not safely check the BunDeck instance mutex (Win32 error " + error + ").");
        }
    }
}
'@
}

$mutexName = 'Local\BunDeck.Launcher.SingleInstance'
if ([BunDeckPerformance.InstanceMutex]::IsPresent($mutexName)) {
    throw 'A BunDeck launcher instance mutex already exists in this Windows session. Refusing to start another launcher.'
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$testName = 'BunDeckLauncherPerf-' + [guid]::NewGuid().ToString('N')
$testRoot = Join-Path $tempBase $testName
$installDir = Join-Path $testRoot 'install'
$dataDir = Join-Path $testRoot 'data'
$roamingDir = Join-Path $testRoot 'roaming'
$localDir = Join-Path $testRoot 'local'
$launcherCopy = Join-Path $installDir 'bundeck-launcher.exe'

$ownedProcess = $null
$ownedPid = $null
$ownedStartTimeUtc = $null
$cleanupSafe = $false
$safeToRemove = $true
$harnessError = $null
$windowLatencyMs = $null
$windowTitle = $null
$cpuSeconds = $null
$averageCpuPercent = $null
$workingSetMinMiB = $null
$workingSetAvgMiB = $null
$workingSetMaxMiB = $null
$workingSetSamples = 0
$thresholdFailures = [Collections.Generic.List[string]]::new()
$thresholdNotEvaluated = [Collections.Generic.List[string]]::new()
$reservedPorts = [Collections.Generic.HashSet[int]]::new()

function Get-FreeLocalPort {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        try {
            $listener.Start()
            $port = ([Net.IPEndPoint] $listener.LocalEndpoint).Port
        }
        finally {
            $listener.Stop()
        }
        if ($script:reservedPorts.Add([int] $port)) {
            return $port
        }
    }
    throw 'Could not select four distinct loopback ports.'
}

function Confirm-OwnedProcess {
    if ($null -eq $ownedProcess -or $null -eq $ownedPid -or $null -eq $ownedStartTimeUtc) {
        return $false
    }
    try {
        $ownedProcess.Refresh()
        if ($ownedProcess.Id -ne $ownedPid -or $ownedProcess.HasExited) {
            return $false
        }
        return $ownedProcess.StartTime.ToUniversalTime() -eq $ownedStartTimeUtc
    }
    catch {
        return $false
    }
}

function Get-OwnedWindows {
    if (-not (Confirm-OwnedProcess)) { return @() }
    return @([BunDeckPerformance.NativeWindows]::VisibleTopLevelWindows([uint32] $ownedPid))
}

try {
    New-Item -ItemType Directory -Path $installDir, $dataDir, $roamingDir, $localDir | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination $launcherCopy

    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $launcherCopy
    $info.WorkingDirectory = $installDir
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $envVars = $info.EnvironmentVariables
    $envVars['APPDATA'] = $roamingDir
    $envVars['LOCALAPPDATA'] = $localDir
    $envVars['BUNDECK_DATA_DIR'] = $dataDir
    $envVars['BUNDECK_INSTALL_DIR'] = $installDir
    $envVars['DEV_MODE'] = 'true'
    $envVars['BUNDECK_BIND'] = '127.0.0.1'
    $envVars['BUNDECK_BIND_LAN'] = '0'
    $envVars['PORT'] = [string] (Get-FreeLocalPort)
    $envVars['WS_PORT'] = [string] (Get-FreeLocalPort)
    $envVars['FRONTEND_PORT'] = [string] (Get-FreeLocalPort)
    $envVars['HOST_PORT'] = [string] (Get-FreeLocalPort)

    Write-Host "Disposable test root: $testRoot"
    Write-Host "Launching copied executable: $launcherCopy"
    $launchStarted = [Diagnostics.Stopwatch]::StartNew()
    $ownedProcess = [Diagnostics.Process]::Start($info)
    if ($null -eq $ownedProcess) {
        throw 'Windows did not return a process handle for the launcher.'
    }
    $ownedPid = $ownedProcess.Id
    $ownedStartTimeUtc = $ownedProcess.StartTime.ToUniversalTime()
    $cleanupSafe = $true

    $windowDeadline = [DateTime]::UtcNow.AddSeconds($WindowTimeoutSeconds)
    $foundWindow = $null
    while ([DateTime]::UtcNow -lt $windowDeadline) {
        if (-not (Confirm-OwnedProcess)) {
            throw "The spawned launcher PID $ownedPid exited before a visible window was observed."
        }
        $windows = @(Get-OwnedWindows)
        if ($windows.Count -gt 0) {
            $foundWindow = $windows[0]
            $windowLatencyMs = $launchStarted.Elapsed.TotalMilliseconds
            $windowTitle = $foundWindow.Title
            break
        }
        Start-Sleep -Milliseconds 100
    }

    if ($null -ne $foundWindow) {
        $shownTitle = if ([string]::IsNullOrWhiteSpace($windowTitle)) { '(no title)' } else { $windowTitle }
        Write-Host ('Startup-to-visible-window: {0:N0} ms (owned PID {1}, title: {2})' -f $windowLatencyMs, $ownedPid, $shownTitle)
    }
    else {
        Write-Warning "No visible top-level window owned by PID $ownedPid was observed within $WindowTimeoutSeconds seconds."
        Write-Host 'Startup-to-window: unavailable; continuing with process metrics only.'
    }

    if (-not (Confirm-OwnedProcess)) {
        throw "The spawned launcher PID $ownedPid exited before sampling."
    }

    if ($WarmupSeconds -gt 0) {
        Write-Host "Warm-up: $WarmupSeconds second(s)..."
        Start-Sleep -Seconds $WarmupSeconds
    }

    $samples = [Collections.Generic.List[long]]::new()
    $ownedProcess.Refresh()
    $cpuAtStart = $ownedProcess.TotalProcessorTime
    $sampleStart = [Diagnostics.Stopwatch]::StartNew()
    $nextSampleAt = 0.0
    while ($sampleStart.Elapsed.TotalSeconds -lt $SamplingSeconds) {
        if (-not (Confirm-OwnedProcess)) {
            throw "The spawned launcher PID $ownedPid exited during the sampling interval."
        }
        $ownedProcess.Refresh()
        $samples.Add([long] $ownedProcess.WorkingSet64)
        $workingSetSamples++

        $nextSampleAt += $SampleIntervalMilliseconds
        $remainingMs = $nextSampleAt - $sampleStart.Elapsed.TotalMilliseconds
        if ($remainingMs -gt 0) {
            Start-Sleep -Milliseconds ([int] [Math]::Min($remainingMs, $SampleIntervalMilliseconds))
        }
    }
    $sampleDurationSeconds = $sampleStart.Elapsed.TotalSeconds
    $ownedProcess.Refresh()
    $cpuAtEnd = $ownedProcess.TotalProcessorTime
    $cpuSeconds = ($cpuAtEnd - $cpuAtStart).TotalSeconds
    $logicalProcessors = [Math]::Max(1, [Environment]::ProcessorCount)
    $averageCpuPercent = 100.0 * $cpuSeconds / ($sampleDurationSeconds * $logicalProcessors)

    $sortedSamples = @($samples | Sort-Object)
    $workingSetMinMiB = $sortedSamples[0] / 1MB
    $workingSetMaxMiB = $sortedSamples[-1] / 1MB
    $workingSetAvgMiB = (($samples | Measure-Object -Average).Average) / 1MB

    Write-Host ''
    Write-Host "Owned launcher PID: $ownedPid"
    Write-Host ('Post-warmup idle sample duration: {0:N2} s; sample cadence: {1} ms; samples: {2}' -f $sampleDurationSeconds, $SampleIntervalMilliseconds, $workingSetSamples)
    Write-Host ('Process CPU time delta: {0:N3} s; average normalized CPU: {1:N2}% of one logical CPU' -f $cpuSeconds, (100.0 * $cpuSeconds / $sampleDurationSeconds))
    Write-Host ('Average CPU normalized across {0} logical processor(s): {1:N2}%' -f $logicalProcessors, $averageCpuPercent)
    Write-Host ('Working set: min {0:N1} MiB, average {1:N1} MiB, max {2:N1} MiB' -f $workingSetMinMiB, $workingSetAvgMiB, $workingSetMaxMiB)
    Write-Host 'Note: the launcher is isolated and has no bundled daemon beside it; this is not a connected-daemon workload.'

    if ($PSBoundParameters.ContainsKey('MaxStartupToWindowMs')) {
        if ($null -eq $windowLatencyMs) {
            $thresholdNotEvaluated.Add('MaxStartupToWindowMs: no visible window measurement')
        }
        elseif ($windowLatencyMs -gt $MaxStartupToWindowMs) {
            $thresholdFailures.Add(('startup-to-window {0:N0} ms > {1:N0} ms' -f $windowLatencyMs, $MaxStartupToWindowMs))
        }
        else {
            Write-Host ('THRESHOLD OK: startup-to-window <= {0:N0} ms' -f $MaxStartupToWindowMs)
        }
    }
    if ($PSBoundParameters.ContainsKey('MaxAverageCpuPercent')) {
        if ($null -eq $averageCpuPercent) {
            $thresholdNotEvaluated.Add('MaxAverageCpuPercent: CPU measurement unavailable')
        }
        elseif ($averageCpuPercent -gt $MaxAverageCpuPercent) {
            $thresholdFailures.Add(('average normalized CPU {0:N2}% > {1:N2}%' -f $averageCpuPercent, $MaxAverageCpuPercent))
        }
        else {
            Write-Host ('THRESHOLD OK: average normalized CPU <= {0:N2}%' -f $MaxAverageCpuPercent)
        }
    }
    if ($PSBoundParameters.ContainsKey('MaxWorkingSetMiB')) {
        if ($null -eq $workingSetMaxMiB) {
            $thresholdNotEvaluated.Add('MaxWorkingSetMiB: working-set measurement unavailable')
        }
        elseif ($workingSetMaxMiB -gt $MaxWorkingSetMiB) {
            $thresholdFailures.Add(('maximum working set {0:N1} MiB > {1:N1} MiB' -f $workingSetMaxMiB, $MaxWorkingSetMiB))
        }
        else {
            Write-Host ('THRESHOLD OK: maximum working set <= {0:N1} MiB' -f $MaxWorkingSetMiB)
        }
    }
}
catch {
    $harnessError = $_.Exception.Message
    Write-Host "HARNESS ERROR: $harnessError" -ForegroundColor Red
}
finally {
    if ($null -ne $ownedProcess) {
        try {
            if ($cleanupSafe) {
                $ownedProcess.Refresh()
                if ($ownedProcess.HasExited) {
                    Write-Host "Owned launcher PID $ownedPid has already exited; no process was stopped."
                }
                elseif ($ownedProcess.Id -eq $ownedPid -and
                    $ownedProcess.StartTime.ToUniversalTime() -eq $ownedStartTimeUtc) {
                    # Kill through the Process object created by this script,
                    # after confirming its PID and creation time still match.
                    $ownedProcess.Kill()
                    $processExited = $ownedProcess.WaitForExit(5000)
                    if (-not $processExited) {
                        $safeToRemove = $false
                        Write-Warning "Owned launcher PID $ownedPid did not exit within five seconds; preserving its temporary files."
                    }
                }
                else {
                    $safeToRemove = $false
                    Write-Warning "Owned process identity could not be reconfirmed for PID $ownedPid; it was not stopped and its temporary files were preserved."
                }
            }
        }
        catch {
            $safeToRemove = $false
            Write-Warning "Could not stop the exact spawned launcher process handle for PID ${ownedPid}: $($_.Exception.Message)"
        }
        finally {
            $ownedProcess.Dispose()
        }
    }

    if ($KeepArtifacts) {
        Write-Host "Kept disposable test files at: $testRoot"
    }
    elseif (-not $safeToRemove) {
        Write-Warning "Temporary files were preserved at: $testRoot"
    }
    elseif (Test-Path -LiteralPath $testRoot) {
        $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
        $expectedPrefix = $tempBase + [IO.Path]::DirectorySeparatorChar
        if ($resolvedRoot.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedRoot) -match '^BunDeckLauncherPerf-[0-9a-f]{32}$') {
            Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
        }
        else {
            Write-Warning "Refusing to remove an unexpected temporary path: $resolvedRoot"
        }
    }
}

if ($harnessError) { exit 1 }
foreach ($message in $thresholdNotEvaluated) {
    Write-Warning "THRESHOLD NOT EVALUATED: $message"
}
foreach ($message in $thresholdFailures) {
    Write-Host "THRESHOLD FAILED: $message" -ForegroundColor Red
}
if ($thresholdFailures.Count -gt 0 -or $thresholdNotEvaluated.Count -gt 0) { exit 2 }
Write-Host 'Performance smoke completed. Thresholds are informational unless explicitly supplied.'

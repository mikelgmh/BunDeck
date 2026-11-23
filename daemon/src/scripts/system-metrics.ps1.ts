/**
 * Script PowerShell de métricas del sistema (Windows).
 *
 * Fase 1+2: además de CPU % y RAM (WMI), intenta en orden:
 *  1. LibreHardwareMonitor / OpenHardwareMonitor vía WMI
 *     (root/LibreHardwareMonitor y root/OpenHardwareMonitor, clase Sensor)
 *     → CPU temp, GPU temp/uso, ventiladores, voltajes. Requiere que el
 *     usuario tenga LHM/OHM corriendo y, para CPU temp/fans/voltajes,
 *     driver kernel (PawnIO/WinRing0) + admin — igual que Macro-Deck.
 *  2. MSAcpi_ThermalZoneTemperature (WMI root/wmi, sin admin ni driver)
 *     → temp aproximada en portátiles/BIOS que lo exponen.
 *  3. nvidia-smi → temp GPU NVIDIA (sin admin).
 *  4. Contadores de rendimiento GPU Engine → % uso GPU (Windows 10+, sin admin).
 *
 * Si nada responde, devuelve null + `sources` honesto (nunca inventa datos).
 * Campos cpu/ram/gpu mantienen compat con versiones anteriores.
 */
export const getSystemMetricsScript = () => `
  try {
    # ---------- CPU % (contador clásico) ----------
    $cpuUsage = $null
    try {
      $counter = Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop
      $cpuUsage = [math]::Round($counter.CounterSamples[0].CookedValue, 1)
    } catch {
      try {
        $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
        $cpuUsage = [math]::Round($cpu.LoadPercentage, 1)
      } catch { $cpuUsage = $null }
    }

    # ---------- RAM (CIM, fiable) ----------
    $totalMemory = $null; $usedMemory = $null; $ramUsage = $null
    try {
      $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
      $totalMemory = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
      $freeMemory = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
      $usedMemory = [math]::Round($totalMemory - $freeMemory, 1)
      $ramUsage = [math]::Round(($usedMemory / $totalMemory) * 100, 1)
    } catch {}

    # ---------- Helpers LHM/OHM vía WMI ----------
    function Get-HwSensors([string]$ns) {
      try { return Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Stop }
      catch { return $null }
    }
    $lhm = Get-HwSensors 'root/LibreHardwareMonitor'
    if (-not $lhm) { $lhm = Get-HwSensors 'root/OpenHardwareMonitor' }
    $hwSource = $null
    if ($lhm) {
      # Detectar namespace real para 'sources'
      try {
        Get-CimInstance -Namespace 'root/LibreHardwareMonitor' -ClassName Sensor -ErrorAction Stop | Out-Null
        $hwSource = 'librehardwaremonitor-wmi'
      } catch { $hwSource = 'openhardwaremonitor-wmi' }
    }

    function Get-HwTemp([string]$like) {
      if (-not $lhm) { return $null }
      try {
        $cands = $lhm | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -like $like }
        $vals = $cands | ForEach-Object { try { [double]$_.Value } catch {} } | Where-Object { $_ -ne $null -and $_ -gt -50 -and $_ -lt 150 }
        if ($vals -and $vals.Count -gt 0) { return [math]::Round(($vals | Measure-Object -Average).Average, 1) }
      } catch {}
      return $null
    }

    # ---------- CPU temperatura ----------
    $cpuTemp = $null; $cpuTempSource = $null
    $cpuTemp = Get-HwTemp '*CPU*'
    if ($cpuTemp -ne $null) { $cpuTempSource = $hwSource }
    if ($cpuTemp -eq $null) {
      # Sin driver: zona térmica ACPI (portátiles). Décimas de Kelvin → °C
      try {
        $tz = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
        $vals = $tz | ForEach-Object { try { ([double]$_.CurrentTemperature) / 10 - 273.15 } catch {} } | Where-Object { $_ -gt -50 -and $_ -lt 150 }
        if ($vals -and $vals.Count -gt 0) {
          $cpuTemp = [math]::Round(($vals | Measure-Object -Maximum).Maximum, 1)
          $cpuTempSource = 'acpi-thermalzone'
        }
      } catch {}
    }

    # ---------- GPU uso ----------
    $gpuUsage = $null; $gpuUsageSource = $null
    try {
      $g = Get-HwSensors 'root/LibreHardwareMonitor'
      if (-not $g) { $g = Get-HwSensors 'root/OpenHardwareMonitor' }
      if ($g) {
        $loads = $g | Where-Object { $_.SensorType -eq 'Load' -and ($_.Name -like '*GPU*' -or $_.Name -like '*D3D*') }
        $vals = $loads | ForEach-Object { try { [double]$_.Value } catch {} } | Where-Object { $_ -ne $null -and $_ -ge 0 -and $_ -le 100 }
        if ($vals -and $vals.Count -gt 0) {
          $gpuUsage = [math]::Round(($vals | Measure-Object -Maximum).Maximum, 1)
          $gpuUsageSource = $hwSource
        }
      }
    } catch {}
    if ($gpuUsage -eq $null) {
      # Contadores de rendimiento (sin admin, Win10+): suma motores 3D
      try {
        $engines = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop
        $sum = 0
        foreach ($s in $engines.CounterSamples) {
          try { $v = [double]$s.CookedValue } catch { $v = 0 }
          if ($v -gt 0 -and $v -le 100) { $sum += $v }
        }
        if ($sum -gt 0) {
          if ($sum -gt 100) { $sum = 100 }
          $gpuUsage = [math]::Round($sum, 1)
          $gpuUsageSource = 'gpu-engine-counter'
        }
      } catch {}
    }
    if ($gpuUsage -eq $null) {
      # nvidia-smi también da % de uso
      try {
        $u = & nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        $uv = 0; [void][double]::TryParse(($u.ToString().Trim()), [ref]$uv)
        if ($uv -ge 0 -and $uv -le 100 -and $u.ToString().Trim() -ne '') {
          $gpuUsage = [math]::Round($uv, 1)
          $gpuUsageSource = 'nvidia-smi'
        }
      } catch {}
    }

    # ---------- GPU temperatura ----------
    $gpuTemp = $null; $gpuTempSource = $null
    $gpuTemp = Get-HwTemp '*GPU*'
    if ($gpuTemp -ne $null) { $gpuTempSource = $hwSource }
    if ($gpuTemp -eq $null) {
      try {
        $t = & nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        $tv = 0; [void][double]::TryParse(($t.ToString().Trim()), [ref]$tv)
        if ($t.ToString().Trim() -ne '' -and $tv -gt -50 -and $tv -lt 150) {
          $gpuTemp = [math]::Round($tv, 1)
          $gpuTempSource = 'nvidia-smi'
        }
      } catch {}
    }

    # ---------- Ventiladores y voltajes (solo LHM/OHM, requieren driver+admin) ----------
    $fans = @()
    $voltages = @()
    if ($lhm) {
      try {
        $fans = @($lhm | Where-Object { $_.SensorType -eq 'Fan' } | ForEach-Object {
          try { @{ name = [string]$_.Name; value = [math]::Round([double]$_.Value, 0); unit = 'RPM' } } catch {}
        } | Where-Object { $_ -ne $null } | Select-Object -First 8)
        $voltages = @($lhm | Where-Object { $_.SensorType -eq 'Voltage' } | ForEach-Object {
          try { @{ name = [string]$_.Name; value = [math]::Round([double]$_.Value, 3); unit = 'V' } } catch {}
        } | Where-Object { $_ -ne $null } | Select-Object -First 8)
      } catch {}
    }

    @{
      cpu = @{ usage = $cpuUsage; temperature = $cpuTemp }
      ram = @{ total = $totalMemory; used = $usedMemory; usage = $ramUsage }
      gpu = @{ usage = $gpuUsage; temperature = $gpuTemp }
      fans = $fans
      voltages = $voltages
      sources = @{
        cpuTemp = $cpuTempSource
        gpuUsage = $gpuUsageSource
        gpuTemp = $gpuTempSource
        hardware = $hwSource
      }
      timestamp = (Get-Date).ToString('o')
    } | ConvertTo-Json -Compress -Depth 5
  } catch {
    @{
      error = $_.Exception.Message
      cpu = @{ usage = $null; temperature = $null }
      ram = @{ total = $null; used = $null; usage = $null }
      gpu = @{ usage = $null; temperature = $null }
      fans = @()
      voltages = @()
      timestamp = (Get-Date).ToString('o')
    } | ConvertTo-Json -Compress -Depth 5
  }
`;

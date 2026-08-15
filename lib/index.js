// dsh-webui-perf Node half：向 Host 用户设置文档注册 webui-perf 命名空间
// （enabled: boolean，默认 true），并提供：
//   GET  /webui-perf/memory  —— 系统内存统计（os.freemem/totalmem）
//   POST /webui-perf/clean   —— 系统级内存清理（PowerShell + Windows API）
//
// 浏览器 half 通过 settingsScope 读写开关并广播给官方包的 cordis-free
// 优化开关通道；右上角内存指示器读 /memory，🧹 按钮调 /clean —— 由 host
// （非沙箱的 Node 进程）执行 PCL 同款的真实内存清理：
//   1) EmptyWorkingSet(dsh host 自身)      —— 工作集交还系统，无条件
//   2) NtSetSystemInformation(MemoryListInformation)
//      —— 清 Windows standby 内存（任务管理器「已用」的大头），需管理员
//   3) EmptyWorkingSet(Edge 的 gpu/utility/network 等缓存型进程)
//      —— 安全子集；绝不碰渲染进程（页面进程强清会卡死/崩溃）
// 脚本硬编码、不接受参数，无命令注入面；只做固定清理动作。
import { execFile } from 'node:child_process'
import { freemem, totalmem } from 'node:os'
import z from 'schemastery'

export const name = 'dsh-webui-perf'
// 硬依赖 settings 与 webServer：cordis 会等两者就绪后再调用 apply。
export const inject = ['settings', 'webServer']

const NS = 'webui-perf'

/** Durable performance-switch section shared by the Host schema and the browser scope. */
export const schema = z.object({
  enabled: z.boolean().default(true),
})

/**
 * PowerShell 清理脚本（固定动作，无参数注入面）。返回 JSON：
 *   { beforeFreeKB, afterFreeKB, standbyOk, edgeFreedMB, admin }
 */
const CLEAN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MemUtil {
  [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr hProcess);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtSetSystemInformation(int cls, IntPtr info, int len);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool AdjustTokenPrivileges(IntPtr tok, bool dis, ref TOKEN_PRIVILEGES tp, uint len, IntPtr prev, IntPtr ret);
  [StructLayout(LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES { public uint Count; public long Luid; public uint Attr; }
}
"@
# 启用 SeProfileSingleProcessPrivilege（清 standby 所需；管理员令牌下默认禁用）
function Enable-ProfilePrivilege {
  $tok = [IntPtr]::Zero
  if (-not [MemUtil]::OpenProcessToken([Diagnostics.Process]::GetCurrentProcess().Handle, 0x28, [ref]$tok)) { return $false }
  try {
    $luid = 0L
    if (-not [MemUtil]::LookupPrivilegeValue($null, 'SeProfileSingleProcessPrivilege', [ref]$luid)) { return $false }
    $tp = New-Object MemUtil+TOKEN_PRIVILEGES
    $tp.Count = 1; $tp.Luid = $luid; $tp.Attr = 2
    return [MemUtil]::AdjustTokenPrivileges($tok, $false, [ref]$tp, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  } finally {
    [MemUtil]::CloseHandle($tok) | Out-Null
  }
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$before = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
# 1) dsh host 自身工作集
[MemUtil]::EmptyWorkingSet([Diagnostics.Process]::GetCurrentProcess().Handle) | Out-Null
# 2) standby 内存（SystemMemoryListInformation = 0x50）；需管理员 + SeProfileSingleProcessPrivilege
$standbyOk = $false
$standbyErr = ''
$privErr = ''
if ($admin) {
  $privOk = Enable-ProfilePrivilege
  $privErr = ('0x{0:X8}' -f ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -band 0xFFFFFFFF))
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  [Runtime.InteropServices.Marshal]::WriteInt32($info, 0)
  $standbyRet = [MemUtil]::NtSetSystemInformation(0x50, $info, 4)
  $standbyOk = ($standbyRet -eq 0)
  if (-not $standbyOk) { $standbyErr = ('0x{0:X8}' -f ($standbyRet -band 0xFFFFFFFF)) }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($info)
}
# 3) Edge 缓存型进程工作集（gpu/utility/network/crashpad/broker，不含 renderer）
$edgeFreed = 0L
Get-Process -Name msedge -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($cmd -match '--type=(gpu|utility|network|crashpad|broker)') {
    $h = [MemUtil]::OpenProcess(0x500, $false, $_.Id)
    if ($h -ne [IntPtr]::Zero) {
      if ([MemUtil]::EmptyWorkingSet($h)) { $edgeFreed += $_.WorkingSet64 }
      [MemUtil]::CloseHandle($h) | Out-Null
    }
  }
}
$after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
[PSCustomObject]@{ beforeFreeKB = $before; afterFreeKB = $after; standbyOk = $standbyOk; standbyErr = $standbyErr; privErr = $privErr; edgeFreedMB = [math]::Round($edgeFreed / 1MB); admin = $admin } | ConvertTo-Json -Compress
`

/**
 * 深度清理脚本 = PCL 社区版（PCL-CE PageOtherTest.vb Ln 313-393）完整复刻：
 *   1) 提权 SeProfileSingleProcessPrivilege + SeIncreaseQuotaPrivilege
 *   2) MemoryEmptyWorkingSets  (SysInfo 80, cmd=2)  ← 清空系统所有进程工作集
 *   3) SystemFileCacheInformation (SysInfo 81, max/min=UINT_MAX)
 *   4) MemoryFlushModifiedList (80, cmd=3)
 *   5) MemoryPurgeStandbyList  (80, cmd=4)
 *   6) MemoryPurgeLowPriorityStandbyList (80, cmd=5)
 *   7) SystemRegistryReconciliationInformation (155, null, 0)
 * 这就是 PCL「内存优化」能对半砍的来源：所有进程物理页换出 + standby 清空，
 * 系统可用内存暴涨；副作用是所有程序切回时短暂换页（数据不丢）。
 */
const CLEAN_SCRIPT_DEEP = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MemUtil2 {
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr h, uint acc, out IntPtr tok);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool LookupPrivilegeValue(string sys, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool AdjustTokenPrivileges(IntPtr tok, bool dis, ref TOKEN_PRIVILEGES tp, uint len, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtSetSystemInformation(int cls, IntPtr info, int len);
  [StructLayout(LayoutKind.Sequential)] public struct TOKEN_PRIVILEGES { public uint Count; public long Luid; public uint Attr; }
}
"@
function Enable-Privilege($name) {
  $tok = [IntPtr]::Zero
  if (-not [MemUtil2]::OpenProcessToken([MemUtil2]::GetCurrentProcess(), 0x28, [ref]$tok)) { return $false }
  try {
    $luid = 0L
    if (-not [MemUtil2]::LookupPrivilegeValue($null, $name, [ref]$luid)) { return $false }
    $tp = New-Object MemUtil2+TOKEN_PRIVILEGES
    $tp.Count = 1; $tp.Luid = $luid; $tp.Attr = 2
    return [MemUtil2]::AdjustTokenPrivileges($tok, $false, [ref]$tp, 0, [IntPtr]::Zero, [IntPtr]::Zero)
  } finally {
    [MemUtil2]::CloseHandle($tok) | Out-Null
  }
}
function Invoke-SysInfo($cls, $cmd) {
  $h = [Runtime.InteropServices.Marshal]::AllocHGlobal(4)
  [Runtime.InteropServices.Marshal]::WriteInt32($h, $cmd)
  $ret = [MemUtil2]::NtSetSystemInformation($cls, $h, 4)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($h)
  return $ret
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$before = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
$privProfile = $false; $privQuota = $false
if ($admin) {
  $privProfile = Enable-Privilege 'SeProfileSingleProcessPrivilege'
  $privQuota = Enable-Privilege 'SeIncreaseQuotaPrivilege'
}
# PCL 完整清理序列（每一步独立记录成败与错误码）
$steps = [ordered]@{}
function Step-SysInfo($key, $cls, $cmd, $len) {
  $h = [Runtime.InteropServices.Marshal]::AllocHGlobal($len)
  if ($len -eq 4) { [Runtime.InteropServices.Marshal]::WriteInt32($h, $cmd) }
  elseif ($len -eq 8) { [Runtime.InteropServices.Marshal]::WriteInt64($h, -1L) }
  $ret = [MemUtil2]::NtSetSystemInformation($cls, $h, $len)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($h)
  $script:steps[$key] = if ($ret -eq 0) { 'ok' } else { ('0x{0:X8}' -f ($ret -band 0xFFFFFFFF)) }
}
Step-SysInfo 'emptyWorkingSets' 80 2 4
Step-SysInfo 'fileCache' 81 0 8
Step-SysInfo 'flushModified' 80 3 4
Step-SysInfo 'purgeStandby' 80 4 4
Step-SysInfo 'purgeLowStandby' 80 5 4
$regRet = [MemUtil2]::NtSetSystemInformation(155, [IntPtr]::Zero, 0)
$steps['registry'] = if ($regRet -eq 0) { 'ok' } else { ('0x{0:X8}' -f ($regRet -band 0xFFFFFFFF)) }
$after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
[PSCustomObject]@{ beforeFreeKB = $before; afterFreeKB = $after; freedGB = [math]::Round(($after - $before) / 1048576, 2); admin = $admin; privProfile = $privProfile; privQuota = $privQuota; steps = $steps } | ConvertTo-Json -Compress -Depth 3
`

/**
 * 提权版深度清理脚本（由 UAC 提权后的 powershell.exe -File 执行）：
 * 与 CLEAN_SCRIPT_DEEP 相同的 PCL 序列，结果写入 $OutFile（提权进程的
 * stdout 无法直接管道回父进程）。
 */
const CLEAN_SCRIPT_DEEP_UAC = CLEAN_SCRIPT_DEEP.replace(
  '[PSCustomObject]@{ beforeFreeKB = $before; afterFreeKB = $after; freedGB = [math]::Round(($after - $before) / 1048576, 2); admin = $admin; privProfile = $privProfile; privQuota = $privQuota; steps = $steps } | ConvertTo-Json -Compress -Depth 3',
  `$json = [PSCustomObject]@{ beforeFreeKB = $before; afterFreeKB = $after; freedGB = [math]::Round(($after - $before) / 1048576, 2); admin = $admin; privProfile = $privProfile; privQuota = $privQuota; steps = $steps; elevated = ([Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value -eq 'S-1-5-32-544') } | ConvertTo-Json -Compress -Depth 3
$json | Set-Content -Path $OutFile -Encoding UTF8
Write-Output $json`,
)

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 深度清理：先以当前令牌直接执行 PCL 序列；若 MemoryEmptyWorkingSets 被拒
 * （非 UAC 提权运行的过滤令牌，Windows 2004+ 的常见限制），自动走
 * Start-Process -Verb RunAs 弹 UAC 提权重试 —— 与 PCL 的
 * StartAsAdmin("--memory") 完全一致。提权子进程把结果写入临时文件。
 * @param res - http response。
 */
async function runCleanDeep(res) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-webui-perf-'))
  const ps1 = join(dir, 'clean.ps1')
  const outFile = join(dir, 'result.json')
  writeFileSync(ps1, `param([string]$OutFile)\n${CLEAN_SCRIPT_DEEP_UAC}`)
  // 诊断日志（文件，避免依赖进程 stdout）
  const debugLog = 'D:/dsh-plugins/dsh-webui-perf/clean-debug.log'
  const dbg = (msg) => {
    try {
      appendFileSync(debugLog, `${new Date().toISOString()} ${msg}\n`)
    } catch { /* 忽略 */ }
  }
  dbg('=== deep clean start ===')
  dbg(`ps1 bytes=${(() => { try { return readFileSync(ps1, 'utf8').length } catch { return -1 } })()}`)
  dbg(`outFile=${outFile}`)

  const finish = (result, usedUac) => {
    rmSync(dir, { recursive: true, force: true })
    dbg(`finish: usedUac=${usedUac} result=${result ? JSON.stringify(result).slice(0, 400) : 'null'}`)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(JSON.stringify({
      ok: true,
      deep: true,
      usedUac,
      result,
      freeAfter: freemem(),
    }))
  }
  const readResult = () => {
    try {
      const raw = readFileSync(outFile)
      // 兼容 UTF-16 LE（Tee-Object）与 UTF-8 带 BOM（PS 5.1 Set-Content -Encoding UTF8）
      const text = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE
        ? raw.toString('utf16le', 2)
        : raw.toString('utf8').replace(/^\uFEFF/, '')
      return JSON.parse(text.trim())
    } catch {
      return null
    }
  }

  let directStdout = ''
  try {
    directStdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-OutFile', outFile], {
      timeout: 60000,
      windowsHide: true,
      encoding: 'utf8',
    })
    dbg('direct run: exit ok')
  } catch (e) {
    dbg(`direct run: failed ${String(e.message ?? e).slice(0, 150)} stdout=${String(e.stdout ?? '').slice(0, 200)}`)
  }
  dbg(`direct stdout: ${directStdout.slice(0, 300) || '(empty)'}`)
  // 进程退出与文件落盘之间留一拍，避免竞态
  await new Promise((resolve) => setTimeout(resolve, 500))
  let result = readResult()
  dbg(`direct result: ${result ? JSON.stringify(result).slice(0, 300) : 'null'}`)
  // stdout 双保险：Tee-Object 会把 JSON 同时打到 stdout，文件失败也能拿结果
  if (result === null && directStdout.trim() !== '') {
    try {
      const parsed = JSON.parse(directStdout.trim().split(/\r?\n/).pop())
      if (parsed && typeof parsed === 'object' && 'steps' in parsed) {
        result = parsed
        dbg('direct result recovered from stdout')
      }
    } catch { /* 非 JSON 输出忽略 */ }
  }
  if (result === null || result.steps?.emptyWorkingSets !== 'ok') {
    // UAC 提权重试（PCL StartAsAdmin 同款；用户取消则结果文件不存在）
    dbg('triggering UAC elevation…')
    try {
      spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${ps1}','-OutFile','${outFile}'`,
      ], { timeout: 120000, windowsHide: true, stdio: 'ignore' })
      dbg('UAC process returned')
    } catch (e) {
      dbg(`UAC failed: ${String(e.message ?? e).slice(0, 150)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    result = readResult()
    dbg(`elevated result: ${result ? JSON.stringify(result).slice(0, 400) : 'null (用户取消或失败)'}`)
    return finish(result, true)
  }
  return finish(result, false)
}

function runClean(res, deep) {
  const script = deep ? CLEAN_SCRIPT_DEEP : CLEAN_SCRIPT
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout) => {
    let result = null
    if (!error && stdout) {
      try {
        result = JSON.parse(stdout.trim().split(/\r?\n/).pop())
      } catch {
        result = null
      }
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(JSON.stringify({
      ok: !error,
      deep,
      result,
      error: error === null ? undefined : String(error.message ?? error).slice(0, 300),
      freeAfter: freemem(),
    }))
  })
}

export function apply(ctx) {
  ctx.settings.register(NS, schema)

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/webui-perf/memory',
      handler: async (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        })
        res.end(JSON.stringify({
          total: totalmem(),
          free: freemem(),
          rss: process.memoryUsage().rss,
          time: Date.now(),
        }))
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/webui-perf/clean',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('POST required')
          return
        }
        runClean(res, false)
      },
    }))
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: '/webui-perf/clean-deep',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('POST required')
          return
        }
        await runCleanDeep(res)
      },
    }))
    return () => {
      for (const disposer of disposers) disposer()
    }
  }, 'dsh-webui-perf: memory routes')
}

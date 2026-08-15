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
 * 深度清理脚本 = 标准脚本 + 清所有 msedge 渲染进程的工作集。
 * EmptyWorkingSet 只把物理页交还系统（内容在换页文件，不丢状态），
 * 切回标签时短暂换页恢复——这正是 PCL 清 Minecraft 进程的原理；
 * 多标签场景能释放数 GB。客户端在调用后会刷新页面，因此自身页面的
 * 短暂换页代价被刷新覆盖。
 */
const CLEAN_SCRIPT_DEEP = CLEAN_SCRIPT.replace(
  `$after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
[PSCustomObject]@{ beforeFreeKB = $before; afterFreeKB = $after; standbyOk = $standbyOk; standbyErr = $standbyErr; privErr = $privErr; edgeFreedMB = [math]::Round($edgeFreed / 1MB); admin = $admin } | ConvertTo-Json -Compress`,
  `# 4) 深度：所有 msedge 渲染进程工作集（换页到磁盘，不丢状态）
$renderFreed = 0L
Get-Process -Name msedge -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($cmd -match '--type=renderer') {
    $h = [MemUtil]::OpenProcess(0x500, $false, $_.Id)
    if ($h -ne [IntPtr]::Zero) {
      if ([MemUtil]::EmptyWorkingSet($h)) { $renderFreed += $_.WorkingSet64 }
      [MemUtil]::CloseHandle($h) | Out-Null
    }
  }
}
$after = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
[PSCustomObject]@{ beforeFreeKB = $before; afterFreeKB = $after; standbyOk = $standbyOk; standbyErr = $standbyErr; privErr = $privErr; edgeFreedMB = [math]::Round($edgeFreed / 1MB); renderFreedMB = [math]::Round($renderFreed / 1MB); admin = $admin } | ConvertTo-Json -Compress`,
)

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
        runClean(res, true)
      },
    }))
    return () => {
      for (const disposer of disposers) disposer()
    }
  }, 'dsh-webui-perf: memory routes')
}

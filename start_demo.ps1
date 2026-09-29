param(
    [string]$Page = "demo.html",
    [int]$Port = 8767,
    [switch]$NoOpen      # 自动化验证时用 -NoOpen，别弹浏览器
)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = "http://127.0.0.1:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)

Write-Host "comm_link local server"
Write-Host "Serving $root"
Write-Host "Open ${prefix}$Page"
Write-Host "Press Ctrl+C to stop."

$listener.Start()
if (-not $NoOpen) { Start-Process "${prefix}$Page" }

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
        if ([string]::IsNullOrWhiteSpace($requestPath)) {
            $requestPath = $Page
        }

        $filePath = Join-Path $root $requestPath
        $resolved = Resolve-Path -LiteralPath $filePath -ErrorAction SilentlyContinue
        if ($null -eq $resolved -or -not $resolved.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            $context.Response.StatusCode = 404
            $context.Response.Close()
            continue
        }

        $bytes = [System.IO.File]::ReadAllBytes($resolved.Path)
        $extension = [System.IO.Path]::GetExtension($resolved.Path).ToLowerInvariant()
        $contentType = switch ($extension) {
            ".html" { "text/html; charset=utf-8" }
            ".js" { "text/javascript; charset=utf-8" }
            ".css" { "text/css; charset=utf-8" }
            ".json" { "application/json; charset=utf-8" }
            default { "application/octet-stream" }
        }

        $context.Response.ContentType = $contentType
        $context.Response.ContentLength64 = $bytes.Length
        $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        $context.Response.Close()
    }
}
finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
}

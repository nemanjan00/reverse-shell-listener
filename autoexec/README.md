# autoexec/

Per-OS scripts the server sends to a mux client right after Hello, so the
client runs them locally for persistence / setup. Files are picked by the
client's reported `runtime.GOOS`:

| File                | Sent when the client's os is | Run with       |
|---------------------|------------------------------|----------------|
| `linux.sh`          | `linux`                      | `sh`           |
| `darwin.sh`         | `darwin` (macOS)             | `sh`           |
| `windows.ps1`       | `windows`                    | `powershell`   |

Drop a file here (or mount the directory as a volume in production via
`AUTOEXEC_DIR`) and any host that connects with a matching OS will receive
and execute it. Output is logged by the client (`[autoexec] ...`), not
streamed back to the dashboard — autoexec is a one-shot post-connect step,
not an interactive channel.

The directory is read live on each host connect, so edits take effect for
the next connecting host without restarting the server.
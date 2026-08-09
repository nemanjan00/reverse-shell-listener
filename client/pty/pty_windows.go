//go:build windows

package pty

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/UserExistsError/conpty"
)

func init() {
	osName = "windows"
}

// Start tries Windows ConPTY first (real pseudo-terminal, so interactive
// programs and keystrokes work), and falls back to a pipe-backed shell on
// older Windows versions or when ConPTY is unavailable.
func Start(command string, cols, rows uint32) (PTY, error) {
	cmdline := commandLine(command)
	if conpty.IsConPtyAvailable() {
		cpty, err := conpty.Start(cmdline, conpty.ConPtyDimensions(int(cols), int(rows)))
		if err == nil {
			supported = true
			return &conPty{cpty}, nil
		}
	}
	supported = false
	return pipeShell(command)
}

// Resize resizes a ConPTY; it is a no-op for the pipe fallback.
func Resize(f PTY, cols, rows uint32) error {
	if c, ok := f.(*conPty); ok {
		return c.Resize(int(cols), int(rows))
	}
	return nil
}

// shellCommand splits the command string into args for exec.Command. On
// Windows we don't wrap in cmd /c — the command is already a full program
// path (e.g. "powershell.exe -NoProfile").
func shellCommand(cmd string) *exec.Cmd {
	parts := strings.Fields(cmd)
	if len(parts) == 0 {
		return exec.Command("cmd.exe")
	}
	return exec.Command(parts[0], parts[1:]...)
}

// commandLine returns a single command-line string for ConPTY.
func commandLine(cmd string) string {
	if strings.TrimSpace(cmd) == "" {
		return "cmd.exe"
	}
	return cmd
}

// platformError returns a descriptive error for unsupported operations.
func platformError(op string) error {
	return fmt.Errorf("%s is not supported on Windows in this build", op)
}

type conPty struct {
	*conpty.ConPty
}

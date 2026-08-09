//go:build windows

package pty

import (
	"fmt"
	"os/exec"
)

func init() {
	osName = "windows"
}

// Start opens a pipe-backed shell because Windows lacks a portable real PTY
// in this build. Mouse and full-screen apps that depend on a TTY will not work
// under the pipe fallback, but regular command IO will.
func Start(command string, cols, rows uint32) (PTY, error) {
	return pipeShell(command)
}

// Resize is a no-op on Windows pipe fallbacks.
func Resize(f PTY, cols, rows uint32) error {
	return nil
}

func shellCommand(cmd string) *exec.Cmd {
	return exec.Command("cmd", "/c", cmd)
}

// platformError returns a descriptive error for unsupported operations.
func platformError(op string) error {
	return fmt.Errorf("%s is not supported on Windows in this build", op)
}

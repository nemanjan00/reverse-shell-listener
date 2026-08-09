//go:build !windows

package pty

import (
	"os"
	"os/exec"

	"github.com/creack/pty"
)

func init() {
	osName = "unix"
	supported = true
}

// Start opens a real PTY running the given shell command with the requested
// initial terminal size.
func Start(command string, cols, rows uint32) (PTY, error) {
	cmd := exec.Command(command)
	cmd.Env = os.Environ()
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return f, nil
}

// Resize updates the terminal size of an open PTY and sends SIGWINCH to the
// process group so the remote application notices immediately.
func Resize(f PTY, cols, rows uint32) error {
	osf, ok := f.(*os.File)
	if !ok {
		return nil
	}
	if err := pty.Setsize(osf, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		return err
	}
	return signalSIGWINCH(osf)
}

func shellCommand(cmd string) *exec.Cmd {
	return exec.Command(cmd)
}

// Package pty wraps the native PTY implementation for the Go client and
// provides a pipe-based fallback for platforms that lack PTY support.
package pty

import (
	"fmt"
	"io"
	"os/exec"
	"sync"
)

// PTY is the minimal interface both real PTYs and pipe fallbacks satisfy.
type PTY interface {
	io.ReadWriteCloser
}

// PlatformName returns a short label for the build target.
func PlatformName() string {
	return fmt.Sprintf("%s/%s", osName, archName)
}

// IsSupported reports whether the current platform has native PTY support.
func IsSupported() bool {
	return supported
}

var (
	supported        = false
	osName, archName = "unknown", "unknown"
)

// pipeShell is a non-PTY fallback used on platforms where a real PTY is not
// available. It returns a combined ReadWriteCloser backed by stdin/stdout pipes.
func pipeShell(command string) (PTY, error) {
	cmd := shellCommand(command)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &pipePTY{stdin: stdin, stdout: stdout, cmd: cmd}, nil
}

type pipePTY struct {
	mu     sync.Mutex
	stdin  io.WriteCloser
	stdout io.ReadCloser
	cmd    *exec.Cmd
	closed bool
}

func (p *pipePTY) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *pipePTY) Write(b []byte) (int, error) { return p.stdin.Write(b) }
func (p *pipePTY) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	_ = p.stdin.Close()
	_ = p.stdout.Close()
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	return nil
}

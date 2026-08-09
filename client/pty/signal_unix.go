//go:build !windows

package pty

import (
	"os"
	"syscall"
	"unsafe"
)

// signalSIGWINCH sends SIGWINCH to the process group associated with the PTY
// master so the remote shell/application re-reads its terminal size.
func signalSIGWINCH(f *os.File) error {
	fd := f.Fd()
	var pgid int
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TIOCGPGRP, uintptr(unsafe.Pointer(&pgid)))
	if errno != 0 {
		return errno
	}
	return syscall.Kill(-pgid, syscall.SIGWINCH)
}

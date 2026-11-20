package main

import "syscall"

func init() {
	// The supervisor can be killed before its defer handlers run. Release the
	// engines and their local listeners when Android terminates their parent.
	engineProcessAttributes = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

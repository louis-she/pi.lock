"""Run the real Pi TUI in a PTY; forward stdin and output without product-only test hooks."""
import os
import pty
import select
import struct
import sys
import termios
import fcntl

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 120, 0, 0))
while True:
    ready, _, _ = select.select([fd, sys.stdin.buffer], [], [], 0.2)
    for source in ready:
        if source == fd:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if not data:
                _, status = os.waitpid(pid, 0)
                sys.exit(os.waitstatus_to_exitcode(status))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        else:
            data = os.read(sys.stdin.fileno(), 4096)
            if data:
                os.write(fd, data)
            else:
                os.kill(pid, 15)

#!/usr/bin/env python3
"""Drive a terminal program in a pty and script keystrokes into it.

The TUI test harness: spawn a command on a pseudo-terminal (so OpenTUI sees
a real TTY and its renderer diffing works), wait until a marker substring
appears in the captured output, then send scripted keys.

Usage:
  python3 scripts/pty-drive.py [--wait SUBSTRING] [--keys "k1:delay,k2:delay"]
      [--settle SECONDS] [--timeout SECONDS] [--dump FILE] -- CMD [ARGS...]

  --wait      output marker that means "app is rendering" (default: "saku")
  --keys      comma-separated keys, each "key:delay" where delay is the
              seconds to pause AFTER the previous key (default: "q:1.0")
  --settle    extra pause after the marker before the first key (default 0.6)
  --timeout   overall budget in seconds (default 15)
  --dump      also write the raw captured output to FILE (default: stdout)

Keys are raw bytes: use "\\x1b" for ESC, "\\r" for Enter. OpenTUI needs keys
sent as short single-character bursts after init (~2-3s), which is why keys
carry delays.

Exit code: the child's exit code when it exits on its own; 1 when the
timeout hit (the child is SIGTERMed, then SIGKILLed).
"""

import argparse
import os
import pty
import select
import signal
import subprocess
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--wait", default="saku", help="output marker that means the app is rendering")
    parser.add_argument("--keys", default="q:1.0", help='comma-separated "key:delay" pairs')
    parser.add_argument("--settle", type=float, default=0.6, help="pause after the marker before the first key")
    parser.add_argument("--timeout", type=float, default=15.0, help="overall budget in seconds")
    parser.add_argument("--dump", default=None, help="also write raw output to this file")
    parser.add_argument("cmd", nargs=argparse.REMAINDER, help="-- CMD [ARGS...]")
    args = parser.parse_args()

    if len(args.cmd) < 2 or args.cmd[0] != "--":
        parser.error("expected `-- CMD [ARGS...]`")
    cmd = args.cmd[1:]

    keys = []
    for spec in args.keys.split(","):
        key, _, delay = spec.partition(":")
        keys.append((key.encode().decode("unicode_escape").encode("latin-1"), float(delay) if delay else 0.3))

    master, slave = pty.openpty()
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)

    out = b""
    t0 = time.time()
    ready = False
    sent = 0
    try:
        while time.time() - t0 < args.timeout:
            r, _, _ = select.select([master], [], [], 0.1)
            if master in r:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk
                if not ready and args.wait.encode() in out:
                    ready = True
            if ready and sent == 0:
                time.sleep(args.settle)
                for key, delay in keys:
                    time.sleep(delay)
                    os.write(master, key)
                sent = 1
            if sent and proc.poll() is not None:
                break
    finally:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()

    sys.stdout.buffer.write(out)
    if args.dump is not None:
        with open(args.dump, "wb") as f:
            f.write(out)
    return proc.returncode if proc.returncode is not None else 1


if __name__ == "__main__":
    sys.exit(main())

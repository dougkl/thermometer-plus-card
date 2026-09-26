#!/usr/bin/env python3
"""Minimal stdlib-only Home Assistant WebSocket API client.

No third-party deps (no pip on this host), so the WebSocket framing
(RFC 6455) is implemented directly on top of a raw socket.
"""
import base64
import json
import os
import socket
import struct
import sys
import urllib.parse


class WS:
    def __init__(self, url, timeout=20):
        u = urllib.parse.urlparse(url)
        self.host = u.hostname
        self.port = u.port or 8123
        self.path = "/api/websocket"
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buf = b""
        self._handshake()

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        # Read until end of HTTP response headers.
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("handshake failed: connection closed")
            self.buf += chunk
        head, _, rest = self.buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise RuntimeError("handshake failed: " + head.decode(errors="replace")[:200])
        self.buf = rest

    def send(self, obj):
        payload = json.dumps(obj).encode()
        header = bytearray([0x81])  # FIN + text frame
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        while True:
            b0, b1 = self._read(2)
            opcode = b0 & 0x0F
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read(8))[0]
            data = self._read(length) if length else b""
            if opcode == 0x9:  # ping -> pong
                self.sock.sendall(b"\x8a\x80" + os.urandom(4))
                continue
            if opcode == 0x8:  # close
                raise RuntimeError("server closed websocket")
            if opcode in (0x1, 0x2):
                return json.loads(data.decode())

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class HAClient:
    def __init__(self, url, token):
        self.ws = WS(url)
        self._id = 0
        hello = self.ws.recv()
        if hello.get("type") != "auth_required":
            raise RuntimeError(f"unexpected greeting: {hello}")
        self.ws.send({"type": "auth", "access_token": token})
        res = self.ws.recv()
        if res.get("type") != "auth_ok":
            raise RuntimeError(f"auth failed: {res}")

    def cmd(self, **payload):
        self._id += 1
        mid = self._id
        payload["id"] = mid
        self.ws.send(payload)
        while True:
            msg = self.ws.recv()
            if msg.get("id") == mid and msg.get("type") == "result":
                return msg

    def subscribe(self, seconds=8, **payload):
        """Send a subscription command and collect events for `seconds`."""
        import time as _t
        self._id += 1
        mid = self._id
        payload["id"] = mid
        self.ws.send(payload)
        events = []
        result = None
        deadline = _t.time() + seconds
        self.ws.sock.settimeout(1.0)
        while _t.time() < deadline:
            try:
                msg = self.ws.recv()
            except Exception:
                continue
            if msg.get("id") != mid:
                continue
            if msg.get("type") == "result":
                result = msg
                if not msg.get("success"):
                    break
            elif msg.get("type") == "event":
                events.append(msg.get("event"))
        return {"result": result, "events": events}

    def close(self):
        self.ws.close()


def main():
    url = os.environ["HA_URL"]
    token = os.environ["HA_TOKEN"]
    c = HAClient(url, token)
    payload = json.loads(sys.argv[1])
    if len(sys.argv) > 2:
        print(json.dumps(c.subscribe(seconds=float(sys.argv[2]), **payload), indent=2))
    else:
        print(json.dumps(c.cmd(**payload), indent=2))
    c.close()


if __name__ == "__main__":
    main()

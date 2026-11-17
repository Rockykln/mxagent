# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
import base64
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

try:
    from mxagent import secure
except ImportError as exc:  # cryptography missing
    secure = None
    SKIP_REASON = f"cryptography not installed: {exc}"
else:
    SKIP_REASON = ""

# docs/reference/protocol-test-vectors.md
SECRET = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8"
MACHINE = "laptop"
NC = base64.b64decode("AAECAwQFBgcICQoLDA0ODw==")
NS = base64.b64decode("EBESExQVFhcYGRobHB0eHw==")
ROOT = "5348dedae3270728831465d9df320287745e48e3f0779fa5d70ccabdf6b6a201"
SESSION = "bffc9b6f251d7529119690fede5719630b3845fa85d65c02cf7ab7b3e0acaf36"
PROOF_CLIENT = "PmLX7WYTETMHz+52Y/GlKbCJCPWClmqrxVuo9J5jjBo="
PROOF_SERVER = "JtUTRpVfuJt7WMLTHPNWzwlsF7xLD34cp+mETaSosMM="
TEXT_C2D = '{"type":"hello","id":1,"name":"demo"}\n'
FRAME_C2D = "AAAAAAAAAAFWFARG38MQnXCirpK5HmZ/c4xbXaYwkVEBVhA2SevLaG4i6ABxyRQn97I8Yjf5lEdisN+R8xM="
TEXT_D2C = '{"type":"authed","machine":"laptop","mac":"JtUTRpVfuJt7WMLTHPNWzwlsF7xLD34cp+mETaSosMM="}\n'
FRAME_D2C = (
    "AAAAAAAAAAGjMr5VocOwRiRMiDM/+pVr162bHYlCqGJu7FfLWPLo3pbp+PnS+ruJKJsjqi/R+CEh2ILHOG7BG62t3f0zfsbCjCic"
    "qYQVZfHSfDDZdP+atEPYUa9okuj6qgijZlUoGEbyTmQBANMmL4By"
)
SECRET_A = "a" * 43
SECRET_B = "b" * 43


@unittest.skipIf(secure is None, SKIP_REASON)
class TestVectors(unittest.TestCase):
    def test_keys(self):
        self.assertEqual(secure.root_key(SECRET).hex(), ROOT)
        self.assertEqual(secure.session_key(SECRET, MACHINE, NC, NS).hex(), SESSION)

    def test_proofs(self):
        self.assertEqual(secure.proof(SECRET, "client", MACHINE, NC, NS), PROOF_CLIENT)
        self.assertEqual(secure.proof(SECRET, "server", MACHINE, NC, NS), PROOF_SERVER)
        self.assertTrue(secure.proof_ok(SECRET, "server", MACHINE, NC, NS, PROOF_SERVER))
        self.assertFalse(secure.proof_ok(SECRET, "server", MACHINE, NC, NS, PROOF_CLIENT))
        self.assertFalse(secure.proof_ok(SECRET, "server", "desktop", NC, NS, PROOF_SERVER))
        self.assertFalse(secure.proof_ok(SECRET, "server", MACHINE, NC, NS, "not base64!"))
        self.assertFalse(secure.proof_ok(SECRET, "server", MACHINE, NC, NS, None))
        self.assertFalse(secure.proof_ok(SECRET, "server", "BAD", NC, NS, PROOF_SERVER))

    def test_frames(self):
        client = secure.Cipher(SECRET, MACHINE, NC, NS, "client")
        self.assertEqual(client.seal(TEXT_C2D), FRAME_C2D)
        self.assertEqual(client.open(FRAME_D2C), TEXT_D2C)
        server = secure.Cipher(SECRET, MACHINE, NC, NS, "server")
        self.assertEqual(server.seal(TEXT_D2C), FRAME_D2C)
        self.assertEqual(server.open(FRAME_C2D), TEXT_C2D)

    def test_formats_enforced(self):
        for bad in ("", "s3cret", "a" * 31, "a" * 257, SECRET[:42] + "=", SECRET[:42] + "+", " " + SECRET):
            with self.assertRaises(ValueError):
                secure.root_key(bad)
        secure.root_key("a" * 32)
        secure.root_key("a" * 256)
        for bad in ("", "Laptop", "a" * 33, "lap top", "café", "lap_top"):
            with self.assertRaises(ValueError):
                secure.proof(SECRET, "client", bad, NC, NS)
            with self.assertRaises(ValueError):
                secure.Cipher(SECRET, bad, NC, NS, "client")


@unittest.skipIf(secure is None, SKIP_REASON)
class TestCipher(unittest.TestCase):
    def setUp(self):
        nc, ns = secure.nonce(), secure.nonce()
        self.client = secure.Cipher(SECRET_A, MACHINE, nc, ns, "client")
        self.server = secure.Cipher(SECRET_A, MACHINE, nc, ns, "server")

    def test_round_trip_both_directions(self):
        for i in range(3):
            self.assertEqual(self.server.open(self.client.seal(f"c{i}\n")), f"c{i}\n")
            self.assertEqual(self.client.open(self.server.seal(f"s{i} é\n")), f"s{i} é\n")

    def test_replay_and_reorder_rejected(self):
        f1, f2 = self.client.seal("a"), self.client.seal("b")
        with self.assertRaises(secure.SecureError):
            self.server.open(f2)
        self.server.open(f1)
        with self.assertRaises(secure.SecureError):
            self.server.open(f1)
        self.assertEqual(self.server.open(f2), "b")

    def test_own_direction_rejected(self):
        frame = self.client.seal("x")
        other = secure.Cipher(SECRET_A, MACHINE, secure.nonce(), secure.nonce(), "client")
        with self.assertRaises(secure.SecureError):
            other.open(frame)

    def test_tampering_rejected(self):
        raw = bytearray(base64.b64decode(self.client.seal("hello")))
        raw[10] ^= 1
        with self.assertRaises(secure.SecureError):
            self.server.open(base64.b64encode(bytes(raw)).decode())

    def test_garbage_rejected(self):
        for bad in ("", "AAAA", "***", 5, base64.b64encode(b"\x00" * 23).decode()):
            with self.assertRaises(secure.SecureError):
                self.server.open(bad)

    def test_wrong_secret_fails(self):
        nc, ns = secure.nonce(), secure.nonce()
        a = secure.Cipher(SECRET_A, MACHINE, nc, ns, "client")
        b = secure.Cipher(SECRET_B, MACHINE, nc, ns, "server")
        with self.assertRaises(secure.SecureError):
            b.open(a.seal("x"))

    def test_wrong_machine_fails(self):
        nc, ns = secure.nonce(), secure.nonce()
        a = secure.Cipher(SECRET_A, MACHINE, nc, ns, "client")
        b = secure.Cipher(SECRET_A, "desktop", nc, ns, "server")
        with self.assertRaises(secure.SecureError):
            b.open(a.seal("x"))

    def test_bad_nonce_length(self):
        with self.assertRaises(secure.SecureError):
            secure.proof(SECRET_A, "client", MACHINE, b"\x00" * 15, b"\x00" * 16)


if __name__ == "__main__":
    unittest.main()

# SPDX-FileCopyrightText: 2026 rockykln
# SPDX-License-Identifier: Apache-2.0
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from mxagent import Agent, Settings, __version__
from mxagent.config import client_env_path, default_socket_path, parse_env_file, resolve
from mxagent.errors import BridgeError, ConfigError

SECRET = "A" * 43


class TestConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.missing = self.dir / "missing.env"

    def tearDown(self):
        self.tmp.cleanup()

    def test_parse_env_file(self):
        text = "# comment\nMXA_URL = wss://bridge.example.org/agent\nexport MXA_MACHINE='laptop'\nOTHER=1\nnoequals\n"
        self.assertEqual(parse_env_file(text), {"MXA_URL": "wss://bridge.example.org/agent", "MXA_MACHINE": "laptop"})

    def test_default_socket(self):
        self.assertEqual(default_socket_path({"XDG_RUNTIME_DIR": "/run/x"}), "/run/x/mxagent.sock")
        self.assertEqual(default_socket_path({"XDG_STATE_HOME": "/s"}), "/s/mxagent/bridge.sock")
        self.assertEqual(default_socket_path({"MXA_STATE_DIR": "/st"}), "/st/bridge.sock")
        s = resolve(env={"XDG_RUNTIME_DIR": "/run/x"}, env_file=self.missing)
        self.assertFalse(s.remote)
        self.assertEqual(s.socket_path, "/run/x/mxagent.sock")

    def test_client_env_location(self):
        self.assertEqual(client_env_path({"XDG_CONFIG_HOME": "/c"}), Path("/c/mxagent/client.env"))

    def test_precedence(self):
        f = self.dir / "client.env"
        f.write_text("MXA_URL=wss://file.example.org\nMXA_MACHINE=file\nMXA_SECRET=filesecret-ffffffffffffffffffffffffffffffff\n")
        env = {"MXA_MACHINE": "envmachine"}
        s = resolve(env=env, env_file=f)
        self.assertEqual((s.url, s.machine, s.secret), ("wss://file.example.org", "envmachine", "filesecret-" + "f" * 32))
        s = resolve(machine="arg", env=env, env_file=f)
        self.assertEqual(s.machine, "arg")
        self.assertNotIn("filesecret", repr(s))

    def test_file_via_xdg_config_home(self):
        cfg = self.dir / "mxagent"
        cfg.mkdir()
        (cfg / "client.env").write_text("MXA_SOCKET_PATH=/tmp/x.sock\n")
        s = resolve(env={"XDG_CONFIG_HOME": str(self.dir)})
        self.assertEqual(s.socket_path, "/tmp/x.sock")

    def test_explicit_socket_wins_over_url(self):
        s = resolve(socket_path="/tmp/a.sock", env={"MXA_URL": "wss://x.example.org"}, env_file=self.missing)
        self.assertFalse(s.remote)
        self.assertEqual(s.socket_path, "/tmp/a.sock")

    def test_remote_needs_credentials(self):
        with self.assertRaisesRegex(ConfigError, "MXA_MACHINE, MXA_SECRET") as ctx:
            resolve(url="wss://x.example.org", env={}, env_file=self.missing)
        self.assertIsInstance(ctx.exception, BridgeError)
        with self.assertRaises(ConfigError):
            resolve(env={"MXA_URL": "wss://x.example.org", "MXA_MACHINE": "m", "MXA_SECRET": ""}, env_file=self.missing)
        with self.assertRaises(ValueError):
            resolve(env={"MXA_URL": "wss://x.example.org", "MXA_MACHINE": "m"}, env_file=self.missing)
        with self.assertRaises(ValueError):
            resolve(env={"MXA_URL": "https://x.example.org", "MXA_MACHINE": "m", "MXA_SECRET": "s"},
                    env_file=self.missing)

    def test_secret_format_checked_verbatim(self):
        def remote(secret, machine="laptop", url="wss://bridge.example.org/agent"):
            return resolve(url=url, machine=machine, secret=secret, env={}, env_file=self.missing)

        self.assertEqual(remote(SECRET).secret, SECRET)
        self.assertEqual(remote("a-_9" * 64).secret, "a-_9" * 64)  # 256 characters
        for bad in ("A" * 31, "A" * 257, SECRET + "=", " " + SECRET, SECRET + "\n", "A" * 42 + "+", "A" * 42 + "é"):
            with self.assertRaisesRegex(ConfigError, "MXA_SECRET"):
                remote(bad)

    def test_machine_and_url_checked(self):
        def remote(url="wss://bridge.example.org/agent", machine="laptop"):
            return resolve(url=url, machine=machine, secret=SECRET, env={}, env_file=self.missing)

        self.assertEqual(remote(url="ws://127.0.0.1:8080/agent").url, "ws://127.0.0.1:8080/agent")
        for bad in ("Laptop", "my laptop", "x" * 33):
            with self.assertRaisesRegex(ConfigError, "MXA_MACHINE"):
                remote(machine=bad)
        for bad in ("wss://", "wss:///agent", "ws://host:notaport/", "http://bridge.example.org"):
            with self.assertRaisesRegex(ConfigError, "MXA_URL"):
                remote(url=bad)

    def test_agent_validates_remote_settings(self):
        with self.assertRaisesRegex(ConfigError, "MXA_SECRET"):
            Agent("x", Settings(url="wss://bridge.example.org/agent", machine="laptop", secret="short"))
        with self.assertRaises(ConfigError):
            Agent("x", Settings(url="wss://bridge.example.org/agent"))
        Agent("x", Settings(url="wss://bridge.example.org/agent", machine="laptop", secret=SECRET))


class TestPackaging(unittest.TestCase):
    def setUp(self):
        try:
            import tomllib
        except ImportError:
            self.skipTest("tomllib needs Python 3.11")
        root = Path(__file__).resolve().parent.parent
        with open(root / "pyproject.toml", "rb") as f:
            self.project = tomllib.load(f)["project"]
        self.root = root

    def test_version_matches_package(self):
        self.assertEqual(self.project["version"], __version__)

    def test_license_files_and_metadata(self):
        self.assertIn("NOTICE", self.project["license-files"])
        for name in self.project["license-files"]:
            self.assertTrue((self.root / name).is_file(), name)
        self.assertIn("Source", self.project["urls"])
        self.assertIn("Typing :: Typed", self.project["classifiers"])


if __name__ == "__main__":
    unittest.main()

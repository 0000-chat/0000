import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import preflight


class PreflightTests(unittest.TestCase):
    def test_supported_lts_is_accepted(self):
        self.assertTrue(preflight.is_supported_ubuntu("26.04"))
        self.assertTrue(preflight.is_supported_ubuntu("24.04"))

    def test_eol_interim_release_is_rejected(self):
        self.assertFalse(preflight.is_supported_ubuntu("25.10"))

    def test_disk_threshold_is_fifty_gib(self):
        self.assertTrue(preflight.has_required_disk(50 * 1024**3))
        self.assertFalse(preflight.has_required_disk(50 * 1024**3 - 1))

    def test_report_fails_when_required_port_is_bound(self):
        facts = preflight.HostFacts(
            ubuntu_version="26.04",
            free_disk_bytes=80 * 1024**3,
            available_memory_bytes=20 * 1024**3,
            swap_in_delta=0,
            swap_out_delta=0,
            bound_ports=frozenset({443}),
            docker_compose=True,
            dns_addresses=frozenset({"203.0.113.10"}),
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn("ports 80 and 443 must be free", report.failures)

    def test_healthy_report_passes(self):
        facts = preflight.HostFacts(
            ubuntu_version="26.04",
            free_disk_bytes=80 * 1024**3,
            available_memory_bytes=20 * 1024**3,
            swap_in_delta=0,
            swap_out_delta=0,
            bound_ports=frozenset(),
            docker_compose=True,
            dns_addresses=frozenset({"203.0.113.10"}),
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertEqual((), report.failures)


if __name__ == "__main__":
    unittest.main()

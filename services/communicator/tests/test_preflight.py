import dataclasses
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import preflight


class PreflightTests(unittest.TestCase):
    def healthy_facts(
        self, dns_a_records=None, dns_aaaa_records=None, collection_failures=()
    ):
        return preflight.HostFacts(
            ubuntu_version="24.04",
            free_disk_bytes=180 * 1024**3,
            available_memory_bytes=10 * 1024**3,
            swap_in_delta=0,
            swap_out_delta=0,
            bound_ports=frozenset(),
            docker_compose=True,
            dns_a_records=dns_a_records
            if dns_a_records is not None
            else {
                domain: ("203.0.113.10",)
                for domain in preflight.DOMAINS
            },
            dns_aaaa_records=dns_aaaa_records
            if dns_aaaa_records is not None
            else {domain: () for domain in preflight.DOMAINS},
            collection_failures=collection_failures,
        )

    def test_supported_lts_is_accepted(self):
        self.assertTrue(preflight.is_supported_ubuntu("26.04"))
        self.assertTrue(preflight.is_supported_ubuntu("24.04"))

    def test_eol_interim_release_is_rejected(self):
        self.assertFalse(preflight.is_supported_ubuntu("25.10"))

    def test_disk_threshold_is_fifty_gib(self):
        self.assertTrue(preflight.has_required_disk(50 * 1024**3))
        self.assertFalse(preflight.has_required_disk(50 * 1024**3 - 1))

    def test_report_fails_when_required_port_is_bound(self):
        facts = dataclasses.replace(self.healthy_facts(), bound_ports=frozenset({443}))
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn("ports 80 and 443 must be free", report.failures)

    def test_report_fails_when_one_domain_is_missing(self):
        facts = self.healthy_facts(
            dns_a_records={
                preflight.DOMAINS[0]: ("203.0.113.10",),
                preflight.DOMAINS[1]: (),
            },
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn(
            f"{preflight.DOMAINS[1]} must have exactly one A record for 203.0.113.10",
            report.failures,
        )

    def test_report_fails_when_all_a_records_are_missing(self):
        facts = self.healthy_facts(dns_a_records={})
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertEqual(2, len(report.failures))

    @mock.patch("preflight.subprocess.run", side_effect=FileNotFoundError("dig"))
    def test_dns_tool_failure_is_structured(self, _run):
        records, errors = preflight.query_dns_records("A")
        self.assertEqual({domain: () for domain in preflight.DOMAINS}, records)
        self.assertEqual(("DNS A query failed: dig is unavailable",), errors)

    def test_report_fails_when_one_domain_has_a_stale_address(self):
        facts = self.healthy_facts(
            dns_a_records={
                preflight.DOMAINS[0]: ("203.0.113.10",),
                preflight.DOMAINS[1]: ("203.0.113.10", "198.51.100.9"),
            },
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn(
            f"{preflight.DOMAINS[1]} must have exactly one A record for 203.0.113.10",
            report.failures,
        )

    def test_report_fails_when_one_domain_resolves_to_the_wrong_address(self):
        facts = self.healthy_facts(
            dns_a_records={
                preflight.DOMAINS[0]: ("203.0.113.10",),
                preflight.DOMAINS[1]: ("198.51.100.9",),
            },
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn(
            f"{preflight.DOMAINS[1]} must have exactly one A record for 203.0.113.10",
            report.failures,
        )

    def test_healthy_report_passes(self):
        report = preflight.evaluate(self.healthy_facts(), "203.0.113.10")
        self.assertEqual((), report.failures)

    def test_report_rejects_a_cname_answer(self):
        facts = self.healthy_facts(
            dns_a_records={
                preflight.DOMAINS[0]: ("203.0.113.10",),
                preflight.DOMAINS[1]: (
                    "target.example.net.",
                    "203.0.113.10",
                ),
            }
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn(
            f"{preflight.DOMAINS[1]} must have exactly one A record for 203.0.113.10",
            report.failures,
        )

    def test_report_rejects_aaaa_until_ipv6_dns_is_approved(self):
        facts = self.healthy_facts(
            dns_aaaa_records={
                preflight.DOMAINS[0]: (),
                preflight.DOMAINS[1]: ("2001:db8::10",),
            }
        )
        report = preflight.evaluate(facts, "203.0.113.10")
        self.assertIn(
            f"{preflight.DOMAINS[1]} must not have an AAAA record",
            report.failures,
        )


if __name__ == "__main__":
    unittest.main()

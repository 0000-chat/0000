#!/usr/bin/env python3
import argparse
import dataclasses
import json
import pathlib
import shutil
import subprocess
import time


GIB = 1024**3
SUPPORTED_UBUNTU = frozenset({"24.04", "26.04"})
DOMAINS = ("communicator.0000.gold", "matrix.communicator.0000.gold")


@dataclasses.dataclass(frozen=True)
class HostFacts:
    ubuntu_version: str
    free_disk_bytes: int
    available_memory_bytes: int
    swap_in_delta: int
    swap_out_delta: int
    bound_ports: frozenset[int]
    docker_compose: bool
    dns_a_records: dict[str, tuple[str, ...]]
    dns_aaaa_records: dict[str, tuple[str, ...]]
    collection_failures: tuple[str, ...]


@dataclasses.dataclass(frozen=True)
class Report:
    failures: tuple[str, ...]
    facts: HostFacts


def is_supported_ubuntu(version: str) -> bool:
    return version in SUPPORTED_UBUNTU


def has_required_disk(free_bytes: int) -> bool:
    return free_bytes >= 50 * GIB


def parse_os_release(path: pathlib.Path = pathlib.Path("/etc/os-release")) -> str:
    values = {}
    for line in path.read_text().splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"')
    if values.get("ID") != "ubuntu":
        return "unsupported"
    return values.get("VERSION_ID", "unknown")


def memory_available() -> int:
    for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return 0


def swap_counters() -> tuple[int, int]:
    values = {}
    for line in pathlib.Path("/proc/vmstat").read_text().splitlines():
        key, value = line.split()
        if key in {"pswpin", "pswpout"}:
            values[key] = int(value)
    return values.get("pswpin", 0), values.get("pswpout", 0)


def swap_delta(seconds: float = 2.0) -> tuple[int, int]:
    before = swap_counters()
    time.sleep(seconds)
    after = swap_counters()
    return after[0] - before[0], after[1] - before[1]


def listening_ports() -> frozenset[int]:
    result = subprocess.run(
        ["ss", "-H", "-ltn"], check=True, text=True, capture_output=True
    )
    ports = set()
    for line in result.stdout.splitlines():
        local = line.split()[3]
        try:
            ports.add(int(local.rsplit(":", 1)[1]))
        except ValueError:
            continue
    return frozenset(ports)


def has_docker_compose() -> bool:
    return subprocess.run(
        ["docker", "compose", "version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


def query_dns_records(
    record_type: str,
) -> tuple[dict[str, tuple[str, ...]], tuple[str, ...]]:
    records = {}
    errors = []
    for domain in DOMAINS:
        try:
            result = subprocess.run(
                ["dig", "+short", domain, record_type],
                check=True,
                text=True,
                capture_output=True,
            )
        except FileNotFoundError:
            records.update({name: () for name in DOMAINS})
            errors.append(f"DNS {record_type} query failed: dig is unavailable")
            break
        except subprocess.CalledProcessError:
            records[domain] = ()
            errors.append(f"DNS {record_type} query failed for {domain}")
            continue
        records[domain] = tuple(
            line.strip() for line in result.stdout.splitlines() if line.strip()
        )
    return records, tuple(errors)


def collect() -> HostFacts:
    swap_in, swap_out = swap_delta()
    dns_a_records, a_errors = query_dns_records("A")
    dns_aaaa_records, aaaa_errors = query_dns_records("AAAA")
    return HostFacts(
        ubuntu_version=parse_os_release(),
        free_disk_bytes=shutil.disk_usage("/").free,
        available_memory_bytes=memory_available(),
        swap_in_delta=swap_in,
        swap_out_delta=swap_out,
        bound_ports=listening_ports(),
        docker_compose=has_docker_compose(),
        dns_a_records=dns_a_records,
        dns_aaaa_records=dns_aaaa_records,
        collection_failures=a_errors + aaaa_errors,
    )


def evaluate(facts: HostFacts, expected_ip: str) -> Report:
    failures = list(facts.collection_failures)
    if not is_supported_ubuntu(facts.ubuntu_version):
        failures.append("Ubuntu 24.04 or 26.04 LTS is required")
    if not has_required_disk(facts.free_disk_bytes):
        failures.append("at least 50 GiB free disk is required")
    if facts.available_memory_bytes < 8 * GIB:
        failures.append("at least 8 GiB available memory is required")
    if facts.swap_in_delta or facts.swap_out_delta:
        failures.append("active swap movement must be investigated")
    if {80, 443} & facts.bound_ports:
        failures.append("ports 80 and 443 must be free")
    if not facts.docker_compose:
        failures.append("Docker Compose v2 is required")
    for domain in DOMAINS:
        if facts.dns_a_records.get(domain, ()) != (expected_ip,):
            failures.append(f"{domain} must have exactly one A record for {expected_ip}")
        if facts.dns_aaaa_records.get(domain, ()):
            failures.append(f"{domain} must not have an AAAA record")
    return Report(tuple(failures), facts)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-ip", required=True)
    args = parser.parse_args()
    report = evaluate(collect(), args.expected_ip)
    facts = dataclasses.asdict(report.facts)
    facts["bound_ports"] = sorted(report.facts.bound_ports)
    facts["dns_a_records"] = {
        domain: list(records) for domain, records in report.facts.dns_a_records.items()
    }
    facts["dns_aaaa_records"] = {
        domain: list(records)
        for domain, records in report.facts.dns_aaaa_records.items()
    }
    print(json.dumps({"failures": report.failures, "facts": facts}, indent=2, sort_keys=True))
    return 1 if report.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

import { describe, expect, test } from "bun:test";

import {
  buildSystemdUnitCallEntry,
  parseSystemdMonitorOutput,
  SystemdMonitorParser,
} from "./bridge-systemd-call-monitor";

const SAMPLE_MONITOR_OUTPUT = `signal time=1710000000.000 sender=org.freedesktop.DBus -> destination=:1.1 serial=1 path=/org/freedesktop/DBus; interface=org.freedesktop.DBus; member=NameAcquired
   string ":1.200"
method call time=1710000001.000 sender=:1.201 -> destination=org.freedesktop.systemd1 serial=7 path=/org/freedesktop/systemd1; interface=org.freedesktop.systemd1.Manager; member=StopUnit
   string "0000-chat-bridge.service"
   string "replace"
method call time=1710000002.000 sender=:1.202 -> destination=org.freedesktop.systemd1 serial=8 path=/org/freedesktop/systemd1; interface=org.freedesktop.systemd1.Manager; member=RestartUnit
   string "other.service"
   string "replace"
method call time=1710000003.000 sender=:1.203 -> destination=org.freedesktop.systemd1 serial=9 path=/org/freedesktop/systemd1; interface=org.freedesktop.systemd1.Manager; member=ReloadOrRestartUnit
   string "0000-chat-bridge.service"
   string "replace"
`;

const SAMPLE_BUSCTL_OUTPUT = `Monitoring bus message stream.
‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=3  Timestamp="Wed 2026-06-24 09:13:34.716812 UTC"
  Sender=:1.16589  Destination=org.freedesktop.systemd1  Path=/org/freedesktop/systemd1  Interface=org.freedesktop.systemd1.Manager  Member=StartUnit
  UniqueName=:1.16589
  MESSAGE "ss" {
          STRING "0000-chat-bridge.service";
          STRING "replace";
  };
`;

describe("bridge systemd call monitor", () => {
  test("parses tracked unit calls from dbus-monitor output", () => {
    expect(parseSystemdMonitorOutput(SAMPLE_MONITOR_OUTPUT)).toEqual([
      {
        method: "StopUnit",
        sender: ":1.201",
        unit: "0000-chat-bridge.service",
      },
      {
        method: "ReloadOrRestartUnit",
        sender: ":1.203",
        unit: "0000-chat-bridge.service",
      },
    ]);
  });

  test("supports incremental line parsing", () => {
    const parser = new SystemdMonitorParser("0000-chat-bridge.service");
    expect(
      parser.pushLine(
        "method call sender=:1.42 -> destination=org.freedesktop.systemd1 path=/org/freedesktop/systemd1; interface=org.freedesktop.systemd1.Manager; member=StartUnit",
      ),
    ).toBeUndefined();
    expect(parser.pushLine('   string "0000-chat-bridge.service"')).toEqual({
      method: "StartUnit",
      sender: ":1.42",
      unit: "0000-chat-bridge.service",
    });
  });

  test("parses tracked unit calls from busctl monitor output", () => {
    expect(parseSystemdMonitorOutput(SAMPLE_BUSCTL_OUTPUT)).toEqual([
      {
        method: "StartUnit",
        sender: ":1.16589",
        unit: "0000-chat-bridge.service",
      },
    ]);
  });

  test("builds redaction-safe audit entries", () => {
    const entry = buildSystemdUnitCallEntry({
      call: {
        method: "StopUnit",
        sender: ":1.99",
        unit: "0000-chat-bridge.service",
      },
      caller: {
        basename: "systemctl",
        cmdlineHash: "abc123",
        pid: 123,
      },
    });

    expect(entry).toMatchObject({
      caller: {
        basename: "systemctl",
        cmdlineHash: "abc123",
        pid: 123,
      },
      event: "bridge.systemd.unit_call",
      level: "info",
      service: "bridge-systemd-call-monitor",
      systemdMethod: "StopUnit",
      systemdSender: ":1.99",
      unit: "0000-chat-bridge.service",
    });
  });
});

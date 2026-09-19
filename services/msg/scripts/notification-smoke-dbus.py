import json
import os
import sys
import unicodedata

import dbus
import dbus.service
import dbus.mainloop.glib
from gi.repository import GLib


SERVICE = "org.freedesktop.Notifications"
OBJECT = "/org/freedesktop/Notifications"

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
bus_name = dbus.service.BusName(SERVICE, bus=bus)


class NotificationService(dbus.service.Object):
    def __init__(self):
        super().__init__(bus_name, OBJECT)
        self.next_id = 1

    @dbus.service.method(SERVICE, in_signature="", out_signature="as")
    def GetCapabilities(self):
        return ["actions", "body", "body-markup", "persistence"]

    @dbus.service.method(SERVICE, in_signature="", out_signature="ssss")
    def GetServerInformation(self):
        return ["msg smoke", "0000-chat", "1.0", "1.2"]

    @dbus.service.method(SERVICE, in_signature="susssasa{sv}i", out_signature="u")
    def Notify(self, app_name, replaces_id, app_icon, summary, body, actions, hints, expire_timeout):
        notification_id = int(replaces_id) or self.next_id
        self.next_id = max(self.next_id, notification_id + 1)
        body_text = str(body)
        expected_origin = os.environ.get("MSG_SMOKE_ORIGIN", "")
        expected_room_path = os.environ.get("MSG_SMOKE_ROOM_PATH", "")
        known_body_metadata = {
            "",
            expected_origin,
            expected_origin + "/",
            str(app_name),
            str(summary),
            "msg notification smoke",
        }
        body_contains_origin = bool(expected_origin) and expected_origin in body_text
        body_contains_room_path = bool(expected_room_path) and expected_room_path in body_text
        body_invisible = bool(body_text) and all(
            character.isspace() or unicodedata.category(character) in {"Cc", "Cf"}
            for character in body_text
        )
        print(json.dumps({
            "type": "notification",
            "id": notification_id,
            "title": str(summary),
            "bodyEmpty": not bool(body_text),
            "bodyMatchesOrigin": body_text in {expected_origin, expected_origin + "/"},
            "bodyContainsOrigin": body_contains_origin,
            "bodyMatchesAppName": body_text == str(app_name),
            "bodyMatchesSummary": body_text == str(summary),
            "bodyMatchesPageTitle": body_text == "msg notification smoke",
            "bodyContainsRoomPath": body_contains_room_path,
            "bodyInvisible": body_invisible,
            "bodyIsOther": bool(body_text)
                and body_text not in known_body_metadata
                and not body_contains_origin
                and not body_contains_room_path
                and not body_invisible,
        }), flush=True)
        return notification_id

    @dbus.service.method(SERVICE, in_signature="u", out_signature="")
    def CloseNotification(self, notification_id):
        self.NotificationClosed(notification_id, 3)

    @dbus.service.signal(SERVICE, signature="uu")
    def NotificationClosed(self, notification_id, reason):
        pass

    @dbus.service.signal(SERVICE, signature="us")
    def ActionInvoked(self, notification_id, action_key):
        pass


service = NotificationService()
loop = GLib.MainLoop()
print(json.dumps({"type": "ready"}), flush=True)


def read_control(fd, condition):
    if condition & GLib.IO_HUP:
        return False
    try:
        command = os.read(fd, 4096).decode("utf-8")
    except OSError:
        return False
    for line in command.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0] == "click":
            service.ActionInvoked(dbus.UInt32(int(fields[1])), dbus.String("default"))
    return True


GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, read_control)
loop.run()

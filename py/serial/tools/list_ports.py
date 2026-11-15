"""serial.tools.list_ports over the ports the page holds open (see serial/__init__.py)."""

import re


class ListPortInfo:
    def __init__(self, device, description="n/a", hwid="n/a", vid=None, pid=None, serial_number=None, manufacturer=None, product=None):
        self.device = self.name = device
        self.description = description
        self.hwid = hwid
        self.vid, self.pid = vid, pid
        self.serial_number = serial_number
        self.manufacturer = manufacturer
        self.product = product
        self.location = self.interface = None

    def __iter__(self):
        return iter((self.device, self.description, self.hwid))

    def __getitem__(self, index):
        return (self.device, self.description, self.hwid)[index]


def comports(include_links=False):
    import json

    import lms_serial

    ports = []
    for entry in json.loads(lms_serial.ports()):
        vid, pid = entry.get("vid"), entry.get("pid")
        hwid = f"USB VID:PID={vid:04X}:{pid:04X}" if vid is not None and pid is not None else "n/a"
        ports.append(ListPortInfo(entry["port"], entry.get("description") or "n/a", hwid, vid, pid))
    return ports


def grep(regexp, include_links=False):
    pattern = re.compile(regexp, re.I)
    for port in comports(include_links):
        if any(pattern.search(text) for text in (port.device, port.description, port.hwid)):
            yield port

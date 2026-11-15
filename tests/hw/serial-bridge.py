"""A serial port of the PC on stdin and stdout, for tests/hw/: the lines DTR and RTS set before
opening, as upstream's UartTransport sets them (the STM32's adapter wants RTS low) and as the
page sets them with Web Serial.

    python3 serial-bridge.py PORT DTR RTS      (DTR, RTS: 1 or 0)
"""

import os
import sys
import threading

import serial

port = serial.Serial()
port.port = sys.argv[1]
port.baudrate = 115200
port.timeout = 0.05
port.dtr = sys.argv[2] == "1"
port.rts = sys.argv[3] == "1"
port.open()


def board_to_stdout():
    while True:
        data = port.read(port.in_waiting or 1)
        if data:
            os.write(1, data)


threading.Thread(target=board_to_stdout, daemon=True).start()
while True:
    chunk = os.read(0, 4096)
    if not chunk:
        break
    port.write(chunk)
port.close()

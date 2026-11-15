"""pyserial's interface over the page's serial ports, for upstream's device package and mpremote.

In the browser the port is a Web Serial port that the page holds open for the whole connection;
here it is reached through the JavaScript module `lms_serial` (src/board/link.ts). This module
gives upstream the part of pyserial 3.5 it uses: Serial, serial_for_url, the exceptions and
serial.tools.list_ports.

A read that has to wait suspends Python with JSPI (pyodide.ffi.run_sync), so the worker keeps
receiving the port's bytes meanwhile. Opening and closing are those of the connection only: the
port itself stays open, so a command never resets the board by toggling its lines (PLAN.md 6.6).
"""

import time

__version__ = "3.5"

PARITY_NONE, PARITY_EVEN, PARITY_ODD, PARITY_MARK, PARITY_SPACE = "N", "E", "O", "M", "S"
STOPBITS_ONE, STOPBITS_ONE_POINT_FIVE, STOPBITS_TWO = 1, 1.5, 2
FIVEBITS, SIXBITS, SEVENBITS, EIGHTBITS = 5, 6, 7, 8


class SerialException(OSError):
    pass


class SerialTimeoutException(SerialException):
    pass


class PortNotOpenError(SerialException):
    def __init__(self):
        super().__init__("Attempting to use a port that is not open")


def _js():
    import lms_serial

    return lms_serial


class Abort(BaseException):
    """The operation of the IDE is over: cancelled, or its time ran out.

    A BaseException, as KeyboardInterrupt is for mpremote on the desktop: no except clause of
    mpremote or upstream takes it for an error of the board."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


_limits = {"deadline": None, "cancel": None}


def set_limits(deadline=None, cancel=None):
    """The end of the current operation (time.monotonic()) and its cancel Event; None clears."""
    _limits["deadline"], _limits["cancel"] = deadline, cancel


def check_limits():
    cancel = _limits["cancel"]
    if cancel is not None and cancel.is_set():
        raise Abort("device.cancelled")
    deadline = _limits["deadline"]
    if deadline is not None and time.monotonic() >= deadline:
        raise Abort("device.timeout")


def run(awaitable):
    """Wait for a JavaScript promise, inside the limits of the operation."""
    from pyodide.ffi import can_run_sync, run_sync

    check_limits()
    if not can_run_sync():
        raise SerialException("the serial port is reachable only from a board call of the IDE")
    try:
        return run_sync(awaitable)
    finally:
        check_limits()


class Serial:
    def __init__(self, port=None, baudrate=9600, bytesize=EIGHTBITS, parity=PARITY_NONE, stopbits=STOPBITS_ONE, timeout=None, xonxoff=False, rtscts=False, write_timeout=None, dsrdtr=False, inter_byte_timeout=None, exclusive=None, **_options):
        self._port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.write_timeout = write_timeout
        self.inter_byte_timeout = inter_byte_timeout
        self._dtr = True
        self._rts = True
        self.is_open = False
        if port is not None:
            self.open()

    # pyserial's older spellings, which mpremote still uses
    interCharTimeout = property(lambda self: self.inter_byte_timeout, lambda self, value: setattr(self, "inter_byte_timeout", value))

    @property
    def port(self):
        return self._port

    @port.setter
    def port(self, value):
        self._port = value

    @property
    def name(self):
        return self._port

    @property
    def dtr(self):
        return self._dtr

    @dtr.setter
    def dtr(self, value):
        self._dtr = bool(value)  # the page sets the lines once, when it opens the port

    @property
    def rts(self):
        return self._rts

    @rts.setter
    def rts(self, value):
        self._rts = bool(value)

    def open(self):
        if self._port is None:
            raise SerialException("Port must be configured before it can be used.")
        if self.is_open:
            raise SerialException("Port is already open.")
        if _js().get(self._port) is None:
            raise SerialException(2, f"could not open port {self._port}: [Errno 2] No such file or directory: {self._port!r}")
        self.is_open = True

    def isOpen(self):
        return self.is_open

    def close(self):
        self.is_open = False

    def _link(self):
        if not self.is_open:
            raise PortNotOpenError()
        link = _js().get(self._port)
        if link is None:
            self.is_open = False
            raise SerialException(f"could not open port {self._port}: the connection was lost")
        return link

    @property
    def in_waiting(self):
        link = self._link()
        check_limits()
        return int(link.available())

    def inWaiting(self):
        return self.in_waiting

    def read(self, size=1):
        link = self._link()
        data = bytearray()
        deadline = None if self.timeout is None else time.monotonic() + self.timeout
        while len(data) < size:
            available = int(link.available())
            if available:
                data += link.take(min(size - len(data), available)).to_bytes()
                continue
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                break
            run(link.wait(int(1000 * (0.05 if remaining is None else min(remaining, 0.05)))))
            link = self._link()
        return bytes(data)

    def read_all(self):
        return self.read(self.in_waiting)

    def write(self, data):
        from pyodide.ffi import to_js

        link = self._link()
        data = bytes(data)
        check_limits()
        link.write(to_js(data))
        return len(data)

    def flush(self):
        run(self._link().drain())

    def reset_input_buffer(self):
        self._link().clear()

    flushInput = reset_input_buffer

    def reset_output_buffer(self):
        pass

    def __enter__(self):
        if self._port is not None and not self.is_open:
            self.open()
        return self

    def __exit__(self, *_exc):
        self.close()


def serial_for_url(url, *args, do_not_open=False, **kwargs):
    port = Serial(None, *args, **kwargs)
    port.port = url
    if not do_not_open:
        port.open()
    return port

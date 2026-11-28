// The page's serial port (src/board/web-serial.ts) with a port that fails where a real one can:
// whatever happens, the port is closed again, or the next connection finds it "already open".
import { describe, expect, it } from 'vitest';
import { BoardPort } from '../../src/board/web-serial.ts';
import type { PythonBridge } from '../../src/py/bridge.ts';

const python = { onSerial: () => () => {}, serial() {} } as unknown as PythonBridge;

/** A port that records whether it is open; the writable locks as a real stream does. */
function fakePort(options: { signals?: Error; write?: Error } = {}) {
  const state = { open: false, closes: 0 };
  const writable = new WritableStream<Uint8Array>({
    write() {
      if (options.write) throw options.write;
    },
  });
  const port = {
    readable: new ReadableStream<Uint8Array>(),
    writable,
    getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
    open: async () => {
      if (state.open) throw new DOMException('The port is already open.', 'InvalidStateError');
      state.open = true;
    },
    setSignals: async () => {
      if (options.signals) throw options.signals;
    },
    close: async () => {
      // as Web Serial: a port whose streams are locked cannot be closed
      if (writable.locked) throw new TypeError('Cannot close a port with a locked stream.');
      state.open = false;
      state.closes++;
    },
  };
  return { port: port as unknown as SerialPort, state };
}

describe('BoardPort', () => {
  it('closes the port again when the connection fails after it was opened', async () => {
    // an adapter whose driver refuses the control lines the STM32's UART profile sets
    const { port, state } = fakePort({ signals: new Error('Failed to set control signals.') });
    await expect(BoardPort.open(port, python, 'stm32h7_uart')).rejects.toThrow(
      'Failed to set control signals.',
    );
    expect(state.open).toBe(false);
    // so the next attempt is a new one, not "The port is already open"
    await expect(BoardPort.open(port, python, 'stm32h7_uart')).rejects.toThrow(
      'Failed to set control signals.',
    );
  });

  it('closes the port after a write that failed', async () => {
    const { port, state } = fakePort({ write: new Error('The device has been lost.') });
    const board = await BoardPort.open(port, python, 'esp32');
    await expect(board.write(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'The device has been lost',
    );
    await board.close();
    expect(state).toEqual({ open: false, closes: 1 });
  });
});

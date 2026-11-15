// UploadProgress's arithmetic, as upstream's test_upload_progress_follows_bytes_and_estimates_inside_a_file
// (tests/test_device_gui.py) checks it on the desktop's dialog.
import { describe, expect, it } from 'vitest';
import { UploadEstimate } from '../../src/ui/upload-progress.ts';

describe('UploadEstimate', () => {
  it('follows the bytes and estimates inside a file', () => {
    let now = 100;
    const estimate = new UploadEstimate(() => now, 5_000);
    expect(estimate.value()).toBeNull(); // busy until the first report
    expect(estimate.shown()).toBe(0);
    now += 4; // preparation: it does not count as writing
    estimate.report(0, 100_000, 'app_main.py', 20_000);
    now += 1; // nothing measured yet: the speed of the last upload moves the bar
    expect(estimate.shown()).toBe(5_000);
    expect(estimate.detail()).toContain('about 19 s left');
    now += 1;
    estimate.report(20_000, 100_000, 'ui.mpy', 80_000); // 10 kB/s so far
    expect(estimate.value()).toBe(200);
    expect(estimate.label()).toContain('ui.mpy');
    expect(estimate.rate).toBe(10_000);
    expect(estimate.detail()).toContain('20 of 98 kB');
    expect(estimate.detail()).toContain('about 8 s left');
    now += 3; // nothing reported: the estimate moves the bar
    expect(estimate.shown()).toBe(50_000);
    expect(estimate.value()).toBe(500);
    now += 60; // a slow file: the bar waits just before its end
    expect(estimate.shown()).toBe(96_000);
    estimate.report(100_000, 100_000, '', 0);
    expect(estimate.value()).toBe(1000);
    expect(estimate.detail()).not.toContain('left');
    expect(new UploadEstimate(() => now).rate).toBe(4000);
  });
});

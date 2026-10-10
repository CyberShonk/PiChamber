import { expect, test } from 'bun:test';
import { nativeChangedFilesGeometry } from './nativeChangedFilesGeometry';
test('short landscape keeps the whole list below the header and above the trigger', () => {
  const result = nativeChangedFilesGeometry({ top: 328, left: 740, right: 838 }, { left: 0, top: 0, width: 853, bottom: 480 }, 74, 'end');
  expect(result.bottom - result.maxHeight).toBe(82);
  expect(result.bottom).toBe(320);
  expect(result.left + result.width <= 845).toBe(true);
});
test('narrow and keyboard-offset viewports clamp width, horizontal position and height', () => {
  const result = nativeChangedFilesGeometry({ top: 115, left: -30, right: 420 }, { left: 12, top: 20, width: 300, bottom: 200 }, 100, 'start');
  expect(result.width).toBe(284);
  expect(result.left).toBe(20);
  expect(result.maxHeight).toBe(0);
});

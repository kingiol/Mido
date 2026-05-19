// @vitest-environment jsdom

import type { CoreEvent } from '@mido/protocol-core';

import { buildEventJsonl, createEventExportFilename, exportEventsAsJsonl } from '../apps/web-demo/src/export-jsonl.js';

type SaveFilePickerWindow = Window & typeof globalThis & {
  showSaveFilePicker?: ReturnType<typeof vi.fn>;
};

describe('web demo jsonl export', () => {
  it('serializes one event per line', () => {
    const events: CoreEvent[] = [
      {
        type: 'RUN_STARTED',
        eventId: 'evt-1',
        runId: 'run-1',
        messageId: 'msg-1',
        sequence: 1,
        timestamp: '2026-04-23T12:00:00.000Z'
      },
      {
        type: 'RUN_FINISHED',
        eventId: 'evt-2',
        runId: 'run-1',
        messageId: 'msg-2',
        sequence: 2,
        timestamp: '2026-04-23T12:00:01.000Z',
        finishReason: 'completed'
      }
    ];

    const jsonl = buildEventJsonl(events);
    expect(jsonl.split('\n')).toHaveLength(2);
    expect(jsonl).toContain('"type":"RUN_STARTED"');
    expect(jsonl).toContain('"type":"RUN_FINISHED"');
  });

  it('generates a jsonl filename with run id', () => {
    const events: CoreEvent[] = [
      {
        type: 'RUN_STARTED',
        eventId: 'evt-1',
        runId: 'run-42',
        messageId: 'msg-1',
        sequence: 1,
        timestamp: '2026-04-23T12:00:00.000Z'
      }
    ];

    const filename = createEventExportFilename(events);
    expect(filename.startsWith('mido-events-run-42-')).toBe(true);
    expect(filename.endsWith('.jsonl')).toBe(true);
  });

  it('uses the save file picker when available', async () => {
    const writes: string[] = [];
    const pickerWindow = window as SaveFilePickerWindow;
    const originalPicker = pickerWindow.showSaveFilePicker;
    const originalCanShare = navigator.canShare;
    const originalShare = navigator.share;

    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn().mockReturnValue(false)
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined
    });

    pickerWindow.showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: async () => ({
        write: async (content: string) => {
          writes.push(content);
        },
        close: async () => {}
      })
    } as never);

    const result = await exportEventsAsJsonl([
      {
        type: 'RUN_STARTED',
        eventId: 'evt-1',
        runId: 'run-7',
        messageId: 'msg-1',
        sequence: 1,
        timestamp: '2026-04-23T12:00:00.000Z'
      }
    ]);

    expect(result.status).toBe('saved');
    expect(writes[0]).toContain('"type":"RUN_STARTED"');

    pickerWindow.showSaveFilePicker = originalPicker;
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: originalCanShare
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: originalShare
    });
  });

  it('prefers sharing a file when the browser supports it', async () => {
    const originalCanShare = navigator.canShare;
    const originalShare = navigator.share;
    const pickerWindow = window as SaveFilePickerWindow;
    const originalPicker = pickerWindow.showSaveFilePicker;

    const shareMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: vi.fn().mockReturnValue(true)
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: shareMock
    });
    pickerWindow.showSaveFilePicker = vi.fn();

    const result = await exportEventsAsJsonl([
      {
        type: 'RUN_STARTED',
        eventId: 'evt-1',
        runId: 'run-8',
        messageId: 'msg-1',
        sequence: 1,
        timestamp: '2026-04-23T12:00:00.000Z'
      }
    ]);

    expect(result).toMatchObject({
      status: 'saved',
      method: 'share'
    });
    expect(shareMock).toHaveBeenCalledTimes(1);
    expect(pickerWindow.showSaveFilePicker).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: originalCanShare
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: originalShare
    });
    pickerWindow.showSaveFilePicker = originalPicker;
  });
});

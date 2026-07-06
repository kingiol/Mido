import type { CoreEvent } from '@mido-agent/protocol-core';

type SaveFilePickerWindow = Window & typeof globalThis & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (content: string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

export function buildEventJsonl(events: CoreEvent[]): string {
  return events.map(event => JSON.stringify(event)).join('\n');
}

export function createEventExportFilename(events: CoreEvent[]): string {
  const runId = events.at(-1)?.runId ?? 'no-run';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `mido-events-${runId}-${timestamp}.jsonl`;
}

export type EventExportResult =
  | { status: 'saved'; filename: string; method: 'share' | 'file-picker' | 'download' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

export async function exportEventsAsJsonl(events: CoreEvent[]): Promise<EventExportResult> {
  if (events.length === 0) {
    return {
      status: 'failed',
      message: 'No events to export.'
    };
  }

  const filename = createEventExportFilename(events);
  const content = buildEventJsonl(events);
  const file = new File([content], filename, {
    type: 'application/x-ndjson'
  });

  if (typeof navigator.canShare === 'function' && typeof navigator.share === 'function') {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: filename,
          files: [file]
        });

        return {
          status: 'saved',
          filename,
          method: 'share'
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        return {
          status: 'cancelled'
        };
      }
    }
  }

  const pickerWindow = window as SaveFilePickerWindow;

  if (typeof pickerWindow.showSaveFilePicker === 'function') {
    try {
      const handle = await pickerWindow.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'JSON Lines',
            accept: {
              'application/x-ndjson': ['.jsonl'],
              'application/json': ['.jsonl']
            }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();

      return {
        status: 'saved',
        filename,
        method: 'file-picker'
      };
    } catch (error) {
      if (isAbortError(error)) {
        return {
          status: 'cancelled'
        };
      }
    }
  }

  try {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    return {
      status: 'saved',
      filename,
      method: 'download'
    };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : 'Unable to start download.'
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

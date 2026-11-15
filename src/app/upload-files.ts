// Device → Upload Files…, as upstream's UploadFilesDialog (ui/device_files.py): files and folders
// of the PC, a folder of the board, and the choice of compiling the Python files to bytecode.
import { html } from 'lit';
import { tr } from '../i18n/tr.ts';
import { pickFiles } from '../storage/download.ts';
import type { Settings } from '../storage/settings.ts';
import type { Dialogs } from '../ui/dialogs.ts';
import type { UploadItem } from './device.ts';

/** ui/device_files.py DESTINATIONS and SKIPPED. */
export const DESTINATIONS = ['/flash', '/sd', '/sd/bin', '/flash/bin', '/'];
const SKIPPED = new Set(['__pycache__', '.git', '.hg', '.svn', '.venv']);

/** folder_items' rule, below the folder itself: no caches, version control or hidden parts. */
export function skippedPath(relative: string): boolean {
  return relative
    .split('/')
    .slice(1)
    .some((part) => SKIPPED.has(part) || part.startsWith('.'));
}

interface Chosen extends UploadItem {
  size: number;
}

const fromFile = (file: File, name: string): Chosen => ({
  name,
  size: file.size,
  read: async () => new Uint8Array(await file.arrayBuffer()),
});

/** A folder of the PC, with names relative to the folder's parent: the folder itself is copied. */
function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export interface UploadChoice {
  items: UploadItem[];
  destination: string;
  compile: boolean;
}

export async function uploadFilesDialog(
  dialogs: Dialogs,
  settings: Settings,
): Promise<UploadChoice | null> {
  const items: Chosen[] = [];
  const selected = new Set<string>();
  let destination = settings.get<string>('device/uploadFiles/destination', '/flash');
  let compile = settings.get<boolean>('device/uploadFiles/compile', false);
  const add = (chosen: Chosen[]) => {
    const known = new Set(items.map((item) => item.name));
    for (const item of chosen) {
      if (!known.has(item.name)) {
        items.push(item);
        known.add(item.name);
      }
    }
    dialogs.refresh();
  };
  const accepted = await dialogs.custom<boolean>(
    tr('Upload Files'),
    (finish) => html`
      <select
        multiple
        size="8"
        aria-label=${tr('Upload Files')}
        data-testid="upload-files-list"
        style="width: 100%"
        @change=${(event: Event) => {
          selected.clear();
          for (const option of (event.target as HTMLSelectElement).selectedOptions) {
            selected.add(option.value);
          }
        }}
      >
        ${items.map(
          (item) => html`<option value=${item.name}>${item.name} (${item.size} B)</option>`,
        )}
      </select>
      <div class="buttons" style="justify-content: flex-start">
        <button
          type="button"
          @click=${async () => add((await pickFiles('')).map((file) => fromFile(file, file.name)))}
        >
          ${tr('Add Files…')}
        </button>
        <button
          type="button"
          @click=${async () =>
            add(
              (await pickFolder())
                .filter((file) => !skippedPath(file.webkitRelativePath))
                .map((file) => fromFile(file, file.webkitRelativePath)),
            )}
        >
          ${tr('Add Folder…')}
        </button>
        <button
          type="button"
          @click=${() => {
            const keep = items.filter((item) => !selected.has(item.name));
            items.splice(0, items.length, ...keep);
            selected.clear();
            dialogs.refresh();
          }}
        >
          ${tr('Remove')}
        </button>
      </div>
      <p>
        <label
          >${tr('Folder on the board')}
          <input
            id="destination"
            list="upload-destinations"
            .value=${destination}
            @input=${(event: Event) => (destination = (event.target as HTMLInputElement).value)}
          />
        </label>
        <datalist id="upload-destinations">
          ${DESTINATIONS.map((value) => html`<option value=${value}></option>`)}
        </datalist>
      </p>
      <p>
        <label
          title=${tr(
            'Faster to start and smaller. main.py and boot.py stay as source, and so must the programs that a shell runs from /bin or that an editor opens.',
          )}
        >
          <input
            type="checkbox"
            id="compile"
            .checked=${compile}
            @change=${(event: Event) => (compile = (event.target as HTMLInputElement).checked)}
          />
          ${tr('Compile Python files to bytecode (.mpy)')}
        </label>
      </p>
      <p>
        ${tr(
          'Files with the same name are replaced; nothing else on the board changes. Binary files are copied as they are.',
        )}
      </p>
      <div class="buttons">
        <button type="button" @click=${() => finish(false)}>${tr('Cancel')}</button>
        <button
          type="button"
          class="primary"
          ?disabled=${!items.length}
          @click=${() => finish(true)}
        >
          ${tr('Upload')}
        </button>
      </div>
    `,
    false,
  );
  if (!accepted) return null;
  destination = destination.trim() || '/';
  settings.set('device/uploadFiles/destination', destination);
  settings.set('device/uploadFiles/compile', compile);
  return { items, destination, compile };
}

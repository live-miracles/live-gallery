import { BoxType, GalleryBox, makeBox } from './utils.js';
import { icon } from './icons.js';

type ToastVariant = 'success' | 'primary' | 'error';
type ToastAction = { label: string; run: () => void };

const presetNameKey = 'live-gallery-preset-name';

type PresetControllerOptions = {
    boxes: GalleryBox[];
    presetMenu: HTMLDetailsElement;
    presetLabel: HTMLElement;
    savedPresetList: HTMLElement;
    presetNameDialog: HTMLDialogElement;
    presetNameTitle: HTMLElement;
    presetNameInput: HTMLInputElement;
    confirmDialog: HTMLDialogElement;
    confirmTitle: HTMLElement;
    confirmMessage: HTMLElement;
    confirmCancelButton: HTMLButtonElement;
    confirmOkButton: HTMLButtonElement;
    newPresetButton: HTMLButtonElement;
    exportPresetButton: HTMLButtonElement;
    copyPresetButton: HTMLButtonElement;
    importPresetButton: HTMLButtonElement;
    importPresetClipboardButton: HTMLButtonElement;
    savePresetButton: HTMLButtonElement;
    render: () => void;
    showToast: (message: string, variant?: ToastVariant, action?: ToastAction) => void;
};

export function createPresetController({
    boxes,
    presetMenu,
    presetLabel,
    savedPresetList,
    presetNameDialog,
    presetNameTitle,
    presetNameInput,
    confirmDialog,
    confirmTitle,
    confirmMessage,
    confirmCancelButton,
    confirmOkButton,
    newPresetButton,
    exportPresetButton,
    copyPresetButton,
    importPresetButton,
    importPresetClipboardButton,
    savePresetButton,
    render,
    showToast,
}: PresetControllerOptions) {
    function boxesToPreset(): PresetBox[] {
        return boxes.map((box) => ({
            name: box.name,
            type: box.type,
            value: box.value,
        }));
    }

    function presetToBoxes(presetBoxes: PresetBox[]): GalleryBox[] {
        return presetBoxes.map((box) =>
            makeBox(box.name, normalizePresetBoxType(box.type), box.value),
        );
    }

    // The Preset button shows the name of the preset the wall was loaded from or saved as.
    let currentName = readCurrentName();

    function readCurrentName(): string {
        try {
            return localStorage.getItem(presetNameKey) ?? '';
        } catch {
            return '';
        }
    }

    function setCurrentName(name: string): void {
        currentName = name;
        try {
            localStorage.setItem(presetNameKey, name);
        } catch {
            // The label is a convenience; losing it is harmless.
        }
        presetLabel.textContent = name || 'Preset';
        presetLabel.title = name ? `Preset: ${name}` : '';
    }

    // The app's own confirmation dialog; resolves true only when the action button is chosen.
    function confirmAction(options: {
        title: string;
        message: string;
        confirmLabel: string;
        destructive?: boolean;
    }): Promise<boolean> {
        confirmTitle.textContent = options.title;
        confirmMessage.textContent = options.message;
        confirmOkButton.textContent = options.confirmLabel;
        confirmOkButton.classList.toggle('btn-primary', !options.destructive);
        confirmOkButton.classList.toggle('btn-destructive', Boolean(options.destructive));
        presetMenu.open = false;
        // Escape leaves the previous answer in returnValue, so clear it first.
        confirmDialog.returnValue = '';
        confirmDialog.showModal();
        // Deleting defaults to Cancel; everything else defaults to the action.
        requestAnimationFrame(() =>
            (options.destructive ? confirmCancelButton : confirmOkButton).focus(),
        );

        return new Promise((resolve) => {
            confirmDialog.addEventListener(
                'close',
                () => resolve(confirmDialog.returnValue === 'default'),
                { once: true },
            );
        });
    }

    // Everything that replaces the wall asks first (unless the wall is empty) and can be
    // undone from the toast it shows.
    async function replaceWall(
        nextBoxes: GalleryBox[],
        name: string,
        message: string,
    ): Promise<void> {
        if (
            boxes.length > 0 &&
            !(await confirmAction({
                title: 'Replace the current boxes?',
                message: `The ${boxes.length === 1 ? 'box' : `${boxes.length} boxes`} on the wall will be replaced. You can undo it right after.`,
                confirmLabel: 'Replace',
            }))
        ) {
            return;
        }

        const previousBoxes = boxes.slice();
        const previousName = currentName;
        boxes.splice(0, boxes.length, ...nextBoxes);
        setCurrentName(name);
        render();
        presetMenu.open = false;
        showToast(message, 'primary', {
            label: 'Undo',
            run: () => {
                boxes.splice(0, boxes.length, ...previousBoxes);
                setCurrentName(previousName);
                render();
            },
        });
    }

    function importPresetBoxes(presetBoxes: PresetBox[] | null): Promise<void> {
        if (!presetBoxes) {
            return Promise.resolve();
        }

        return replaceWall(presetToBoxes(presetBoxes), '', 'Preset imported');
    }

    function renderSavedPresets(presets: SavedPreset[]): void {
        savedPresetList.replaceChildren();

        if (presets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-label-3 px-2.5 py-1 text-xs';
            empty.textContent = 'No saved presets';
            savedPresetList.appendChild(empty);
            return;
        }

        presets.forEach((preset) => {
            const row = document.createElement('div');
            row.className = 'group/preset grid grid-cols-[1fr_auto_auto] items-center gap-0.5';

            const loadButton = document.createElement('button');
            loadButton.type = 'button';
            loadButton.className = 'menu-item min-w-0 truncate';
            loadButton.textContent = preset.name;
            loadButton.title = preset.name;
            loadButton.addEventListener('click', () => {
                replaceWall(
                    presetToBoxes(preset.boxes),
                    preset.name,
                    `Loaded “${preset.name}”`,
                ).catch((error) => {
                    console.error('Could not load preset:', error);
                    showToast('Could not load preset', 'error');
                });
            });

            const renameButton = document.createElement('button');
            renameButton.type = 'button';
            renameButton.className =
                'btn btn-sm btn-icon btn-muted opacity-0 group-hover/preset:opacity-100 focus-visible:opacity-100';
            renameButton.innerHTML = icon('pencil');
            renameButton.title = 'Rename preset';
            renameButton.setAttribute('aria-label', 'Rename preset');
            renameButton.addEventListener('click', (event) => {
                event.stopPropagation();
                renameSavedPreset(preset.name).catch((error) => {
                    console.error('Could not rename preset:', error);
                    showToast('Rename failed', 'error');
                });
            });

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className =
                'btn btn-sm btn-icon btn-muted btn-danger opacity-0 group-hover/preset:opacity-100 focus-visible:opacity-100';
            deleteButton.innerHTML = icon('trash');
            deleteButton.title = 'Delete preset';
            deleteButton.setAttribute('aria-label', 'Delete preset');
            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                deleteSavedPreset(preset.name).catch((error) => {
                    console.error('Could not delete preset:', error);
                    showToast('Delete failed', 'error');
                });
            });

            row.append(loadButton, renameButton, deleteButton);
            savedPresetList.appendChild(row);
        });
    }

    function refresh(): void {
        window.liveGallery
            .listPresets()
            .then(renderSavedPresets)
            .catch((error) => {
                console.error('Could not load presets:', error);
                showToast('Could not load presets', 'error');
            });
    }

    function promptPresetName(message: string, defaultValue = ''): Promise<string | null> {
        presetNameTitle.textContent = message;
        presetNameInput.value = defaultValue;
        presetMenu.open = false;
        presetNameDialog.showModal();
        requestAnimationFrame(() => {
            presetNameInput.focus();
            presetNameInput.select();
        });

        return new Promise((resolve) => {
            presetNameDialog.addEventListener(
                'close',
                () => {
                    const name = presetNameInput.value.trim();
                    resolve(presetNameDialog.returnValue === 'default' && name ? name : null);
                },
                { once: true },
            );
        });
    }

    async function saveCurrentPreset(): Promise<void> {
        const name = await promptPresetName('Preset name');
        if (!name) {
            return;
        }

        const presets = await window.liveGallery.listPresets();
        // Match the file-safe form the main process saves under.
        const savedName = name
            .trim()
            .replace(/[\\/:*?"<>|]/g, '-')
            .toLowerCase();
        const existing = presets.find((preset) => preset.name.toLowerCase() === savedName);
        if (
            existing &&
            !(await confirmAction({
                title: 'Overwrite preset?',
                message: `A preset named “${existing.name}” already exists. Saving replaces its boxes with the current ones.`,
                confirmLabel: 'Overwrite',
            }))
        ) {
            return;
        }

        window.liveGallery
            .savePreset(name, boxesToPreset())
            .then((presets) => {
                renderSavedPresets(presets);
                setCurrentName(name);
                showToast('Preset saved');
            })
            .catch((error) => {
                console.error('Could not save preset:', error);
                showToast('Save failed', 'error');
            });
    }

    async function renameSavedPreset(oldName: string): Promise<void> {
        const newName = await promptPresetName('Preset name', oldName);
        if (!newName || newName === oldName) {
            return;
        }

        window.liveGallery
            .renamePreset(oldName, newName)
            .then((presets) => {
                renderSavedPresets(presets);
                if (currentName === oldName) {
                    setCurrentName(newName);
                }
            })
            .catch((error) => {
                console.error('Could not rename preset:', error);
                showToast('Rename failed', 'error');
            });
    }

    async function deleteSavedPreset(name: string): Promise<void> {
        if (
            !(await confirmAction({
                title: 'Delete preset?',
                message: `“${name}” will be deleted from your saved presets. This cannot be undone.`,
                confirmLabel: 'Delete',
                destructive: true,
            }))
        ) {
            return;
        }

        window.liveGallery
            .deletePreset(name)
            .then((presets) => {
                renderSavedPresets(presets);
                if (currentName === name) {
                    setCurrentName('');
                }
                showToast('Preset deleted');
            })
            .catch((error) => {
                console.error('Could not delete preset:', error);
                showToast('Delete failed', 'error');
            });
    }

    function init(): void {
        setCurrentName(currentName);
        newPresetButton.addEventListener('click', () => {
            replaceWall([], '', 'Started a new preset').catch((error) => {
                console.error('Could not start a new preset:', error);
                showToast('Could not start a new preset', 'error');
            });
        });

        exportPresetButton.addEventListener('click', () => {
            window.liveGallery
                .exportPreset(boxesToPreset())
                .then((exported) => {
                    if (exported) {
                        showToast('Preset exported');
                        presetMenu.open = false;
                    }
                })
                .catch((error) => {
                    console.error('Could not export preset:', error);
                    showToast('Export failed', 'error');
                });
        });

        // Same JSON as the exported file, so Import from Clipboard reads it back.
        copyPresetButton.addEventListener('click', () => {
            window.liveGallery
                .copyText(JSON.stringify(boxesToPreset(), null, 2))
                .then(() => {
                    showToast('Preset copied');
                    presetMenu.open = false;
                })
                .catch((error) => {
                    console.error('Could not copy preset:', error);
                    showToast('Copy failed', 'error');
                });
        });

        importPresetButton.addEventListener('click', () => {
            window.liveGallery
                .importPreset()
                .then(importPresetBoxes)
                .catch((error) => {
                    console.error('Could not import preset:', error);
                    showToast('Import failed', 'error');
                });
        });

        importPresetClipboardButton.addEventListener('click', () => {
            window.liveGallery
                .importPresetFromClipboard()
                .then(importPresetBoxes)
                .catch((error) => {
                    console.error('Could not import preset from clipboard:', error);
                    showToast('Clipboard import failed', 'error');
                });
        });

        savePresetButton.addEventListener('click', () => {
            saveCurrentPreset().catch((error) => {
                console.error('Could not save preset:', error);
                showToast('Save failed', 'error');
            });
        });
    }

    init();

    return {
        refresh,
    };
}

function normalizePresetBoxType(type: string): BoxType {
    const allowed = new Set<BoxType>(['YT', 'JW', 'VC', 'SS', 'CU', 'LF']);
    return allowed.has(type as BoxType) ? (type as BoxType) : 'YT';
}

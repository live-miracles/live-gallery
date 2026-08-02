import { BoxType, GalleryBox, makeBox } from './utils.js';
import { icon } from './icons.js';

type ToastVariant = 'success' | 'error';

type PresetControllerOptions = {
    boxes: GalleryBox[];
    presetMenu: HTMLDetailsElement;
    savedPresetList: HTMLElement;
    presetNameDialog: HTMLDialogElement;
    presetNameTitle: HTMLElement;
    presetNameInput: HTMLInputElement;
    newPresetButton: HTMLButtonElement;
    exportPresetButton: HTMLButtonElement;
    importPresetButton: HTMLButtonElement;
    importPresetClipboardButton: HTMLButtonElement;
    savePresetButton: HTMLButtonElement;
    render: () => void;
    showToast: (message: string, variant?: ToastVariant) => void;
};

export function createPresetController({
    boxes,
    presetMenu,
    savedPresetList,
    presetNameDialog,
    presetNameTitle,
    presetNameInput,
    newPresetButton,
    exportPresetButton,
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

    function loadPresetBoxes(presetBoxes: PresetBox[]): void {
        boxes.splice(0, boxes.length, ...presetToBoxes(presetBoxes));
        if (boxes.length === 0) {
            boxes.push(makeBox());
        }
        render();
    }

    function importPresetBoxes(presetBoxes: PresetBox[] | null): void {
        if (!presetBoxes) {
            return;
        }

        loadPresetBoxes(presetBoxes);
        showToast('Preset imported');
        presetMenu.open = false;
    }

    function renderSavedPresets(presets: SavedPreset[]): void {
        savedPresetList.replaceChildren();

        if (presets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'text-base-content/60 px-2 py-1 text-xs';
            empty.textContent = 'No saved presets';
            savedPresetList.appendChild(empty);
            return;
        }

        presets.forEach((preset) => {
            const row = document.createElement('div');
            row.className = 'grid grid-cols-[1fr_auto_auto] items-center gap-1';

            const loadButton = document.createElement('button');
            loadButton.type = 'button';
            loadButton.className =
                'btn btn-ghost btn-xs justify-start truncate hover:bg-accent hover:text-accent-content';
            loadButton.textContent = preset.name;
            loadButton.title = preset.name;
            loadButton.addEventListener('click', () => {
                loadPresetBoxes(preset.boxes);
                presetMenu.open = false;
            });

            const renameButton = document.createElement('button');
            renameButton.type = 'button';
            renameButton.className = 'btn btn-accent btn-xs btn-outline box-tool-btn';
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
            deleteButton.className = 'btn btn-error btn-xs btn-outline box-tool-btn';
            deleteButton.innerHTML = icon('trash');
            deleteButton.title = 'Delete preset';
            deleteButton.setAttribute('aria-label', 'Delete preset');
            deleteButton.addEventListener('click', (event) => {
                event.stopPropagation();
                deleteSavedPreset(preset.name);
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
        const existing = presets.find((preset) => preset.name.toLowerCase() === name.toLowerCase());
        if (
            existing &&
            !window.confirm(`Preset "${existing.name}" already exists. Overwrite it?`)
        ) {
            return;
        }

        window.liveGallery
            .savePreset(name, boxesToPreset())
            .then((presets) => {
                renderSavedPresets(presets);
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
            .then(renderSavedPresets)
            .catch((error) => {
                console.error('Could not rename preset:', error);
                showToast('Rename failed', 'error');
            });
    }

    function deleteSavedPreset(name: string): void {
        if (!window.confirm(`Delete preset "${name}"?`)) {
            return;
        }

        window.liveGallery
            .deletePreset(name)
            .then((presets) => {
                renderSavedPresets(presets);
                showToast('Preset deleted');
            })
            .catch((error) => {
                console.error('Could not delete preset:', error);
                showToast('Delete failed', 'error');
            });
    }

    function init(): void {
        newPresetButton.addEventListener('click', () => {
            boxes.splice(0, boxes.length, makeBox());
            render();
            presetMenu.open = false;
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

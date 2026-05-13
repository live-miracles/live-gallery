import { contextBridge } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

contextBridge.exposeInMainWorld('liveGallery', {
    guestPreloadUrl: pathToFileURL(path.join(__dirname, 'guest-preload.cjs')).toString(),
});

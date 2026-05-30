type IconName =
    | 'eye'
    | 'eye-off'
    | 'grip'
    | 'headphones'
    | 'maximize'
    | 'pencil'
    | 'plus'
    | 'refresh'
    | 'trash'
    | 'volume-2'
    | 'volume-x'
    | 'x';

const paths: Record<IconName, string> = {
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />',
    'eye-off':
        '<path d="M10.7 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2" /><path d="M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5.4-1.5" /><path d="M14.1 14.1A3 3 0 0 1 9.9 9.9" /><path d="M3 3l18 18" />',
    grip: '<circle cx="9" cy="5" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="19" r="1" />',
    headphones:
        '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />',
    maximize:
        '<path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M21 16v3a2 2 0 0 1-2 2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" />',
    pencil: '<path d="M21.2 6.8 17.2 2.8a2 2 0 0 0-2.8 0L3 14.2V21h6.8L21.2 9.6a2 2 0 0 0 0-2.8Z" /><path d="m14 4 6 6" />',
    plus: '<path d="M12 5v14" /><path d="M5 12h14" />',
    refresh:
        '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8" /><path d="M21 3v5h-5" />',
    trash: '<path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" />',
    'volume-2':
        '<path d="M11 5 6 9H2v6h4l5 4Z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a10 10 0 0 1 0 14" />',
    'volume-x': '<path d="M11 5 6 9H2v6h4l5 4Z" /><path d="m22 9-6 6" /><path d="m16 9 6 6" />',
    x: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
};

export function icon(name: IconName, className = 'h-3.5 w-3.5'): string {
    return `<svg aria-hidden="true" viewBox="0 0 24 24" class="${className}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

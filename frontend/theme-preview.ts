// Temporary: lets you flip between the candidate themes while comparing. Delete this file
// and its <script> tag in index.html once one is chosen.
const themes = ['linear', 'raycast', 'supabase', 'sentry', 'vercel', 'cursor', 'hokusai'];
const storageKey = 'theme-preview-2';

function load(): string {
    try {
        const saved = localStorage.getItem(storageKey);
        return saved && themes.includes(saved) ? saved : 'linear';
    } catch {
        return 'linear';
    }
}

function apply(theme: string): void {
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem(storageKey, theme);
    } catch {
        // Preview only; losing the choice is harmless.
    }
}

const select = document.createElement('select');
select.className = 'field field-sm fixed right-3 bottom-3 z-[400] w-28';
select.title = 'Theme preview';
select.setAttribute('aria-label', 'Theme preview');
themes.forEach((theme) => select.add(new Option(theme, theme)));
select.value = load();
apply(select.value);
select.addEventListener('change', () => apply(select.value));
document.body.append(select);

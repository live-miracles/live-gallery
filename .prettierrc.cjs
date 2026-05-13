module.exports = {
    printWidth: 100,
    useTabs: false,
    tabWidth: 4,
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    arrowParens: 'always',
    bracketSameLine: true,
    endOfLine: 'auto',
    plugins: [],
    overrides: [
        {
            files: '*.html',
            options: {
                tabWidth: 2,
                printWidth: 150,
            },
        },
    ],
};

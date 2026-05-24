// Explicit reference so the IDE's TS server always loads `@types/chrome`,
// even when VS Code is rooted at the parent project and its bundled TS
// doesn't auto-discover the extension's local `node_modules/@types/`.
/// <reference types="chrome" />

export {}

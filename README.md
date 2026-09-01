# ReadTaylor

ReadTaylor is a local-first ebook reader. The web build opens TXT, Markdown,
PDF, and EPUB files in the browser. The Windows desktop build keeps the same
interface and adds local conversion for MOBI, AZW, AZW3, CBZ, CBR, ZIP, and
PDF sources before opening them in the EPUB reader.

Books are not uploaded by the application. ReadTaylor does not remove DRM or
password protection.

## Web development

```powershell
npm install
npm run dev
```

Create a production web build with:

```powershell
npm run build
```

## Windows desktop development

Electron is used only as the desktop host. The renderer has no Node.js access;
it receives narrowly scoped APIs for choosing books, checking the converter,
and preparing an EPUB.

```powershell
npm run dev:desktop
```

EPUB, TXT, Markdown, PDF, CBZ, and ZIP can be opened without Calibre. PDF,
CBZ, and ZIP are converted to a fixed-layout EPUB by ReadTaylor itself. Only
MOBI, AZW, AZW3, and CBR require Calibre's `ebook-convert`. During development
ReadTaylor checks, in order:

1. `READTAYLOR_CALIBRE_PATH`
2. `vendor/calibre`
3. a normal system Calibre installation
4. the system `PATH`

Nothing downloads Calibre automatically. To explicitly download the official
portable release into `vendor/calibre`, run:

```powershell
npm run calibre:prepare
```

The download script also records the exact corresponding source archive URL
required for GPL distribution.

## Verification and packaging

```powershell
npx tsc --noEmit
npm run test:desktop
npm run build
npm run build:desktop
```

`build:desktop` refuses to create an installer unless the bundled Calibre
runtime and its source notice are present. Desktop installers are written to
`release`.

# Third-party notices

ReadTaylor's desktop edition uses the following open-source components.

## Calibre

Calibre is licensed under the GNU General Public License version 3. ReadTaylor
uses Calibre's `ebook-convert` command locally to convert DRM-free books. It
does not include or provide DRM-removal functionality.

- Project: https://calibre-ebook.com/
- License: https://www.gnu.org/licenses/gpl-3.0.html
- Release source archives: https://download.calibre-ebook.com/

When the bundled runtime is prepared, its exact version and corresponding
source archive URL are written to `calibre/calibre-source.txt` and included in
the installed application's resources.

## Electron

Electron is licensed under the MIT License. Its license and the licenses of
packaged Node.js dependencies are included by Electron Builder in the desktop
application resources.

- Project: https://www.electronjs.org/
- License: https://github.com/electron/electron/blob/main/LICENSE

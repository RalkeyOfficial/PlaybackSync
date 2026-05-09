# PlaybackSync

A Nextcloud app for synchronized video playback across groups.

## Code Style

- No author, license, or SPDX headers in any file. Ever. This includes `@author`, `@copyright`, `SPDX-FileCopyrightText`, `SPDX-License-Identifier`, and the like.
- Comments are fine when they explain the *why*, not the *what*.
- "No docblock boilerplate" applies **only** to the author/license/SPDX kind of header. Real JSDoc / PHPDoc with meaningful descriptions is welcome — write proper `@param` descriptions, don't leave empty `/** */` skeletons. Functional PHPDoc like `@method` hints on `Entity` subclasses is not boilerplate.
- Don't disable `jsdoc/*` ESLint rules to silence missing-description warnings; fill in the descriptions.

## Old Code

This is a refactor / recode of the old (incomplete) version of this project to become a nextcloud app instead of a standalone app. Old code, alongside documentation, can be read in `./OLD_CODE`, which may give proper insight.

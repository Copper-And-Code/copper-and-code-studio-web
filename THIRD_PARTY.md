# Third-party components

Every dependency is listed here with its licence. GPL-incompatible licences are not allowed.

## Shipped in the site

| Component                                                                                 | Version        | Licence                                                | Use                               |
| ----------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------ | --------------------------------- |
| LVGL MPY Studio (`upstream/`)                                                             | the pinned tag | GPL-3.0-or-later; generated code and runtime files MIT | Python core, runtime files, data  |
| Lit (`lit`, `lit-html`, `lit-element`, `@lit/reactive-element`, `@lit-labs/ssr-dom-shim`) | 3.3.3          | BSD-3-Clause                                           | UI components                     |
| `@types/trusted-types`                                                                    | as locked      | MIT                                                    | type definitions pulled in by Lit |

## Development only (not shipped)

| Component                       | Version         | Licence    |
| ------------------------------- | --------------- | ---------- |
| Vite                            | 8.3.5           | MIT        |
| TypeScript                      | 6.0.3           | Apache-2.0 |
| Vitest                          | 5.0.5           | MIT        |
| Playwright (`@playwright/test`) | 1.64.1          | Apache-2.0 |
| ESLint, `@eslint/js`            | 10.14.0, 10.0.1 | MIT        |
| typescript-eslint               | 8.72.1          | MIT        |
| Prettier                        | 3.9.10          | MIT        |
| globals                         | 17.13.0         | MIT        |
| `@types/node`                   | 26.6.6          | MIT        |

The full list of transitive development packages is in `pnpm-lock.yaml`.

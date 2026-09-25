import { rmSync } from 'node:fs';

for (const file of ['README.md', 'LICENSE']) rmSync(new URL(`../${file}`, import.meta.url), { force: true });

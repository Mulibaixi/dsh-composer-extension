import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
await mkdir(new URL('dist/', root), { recursive: true })
await copyFile(fileURLToPath(new URL('scripts/apply-host-patch.ps1', root)), fileURLToPath(new URL('dist/host-patch-helper.ps1', root)))

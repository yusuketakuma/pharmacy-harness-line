import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  listPharmacyRichMenuVariantOrders,
  getPharmacyRichMenuPresentation,
  type PharmacyRichMenuActionKey,
  type PharmacyRichMenuBounds,
  type PharmacyRichMenuSize,
} from '../../../apps/worker/src/custom/pharmacy/rich-menu/layout.js';
import { validateRichMenuImage } from '../../../apps/worker/src/lib/image-validator.js';
import { PHARMACY_RICH_MENU_CATALOG_VERSION } from '../../../apps/worker/src/custom/pharmacy/rich-menu/catalog.js';

type CatalogCell = PharmacyRichMenuActionKey | 'all-functions';

export type PharmacyRichMenuCatalogJob = {
  variantKey: string;
  orderedActions: PharmacyRichMenuActionKey[];
  cells: CatalogCell[];
  size: PharmacyRichMenuSize;
  bounds: PharmacyRichMenuBounds[];
};

const SLOT_BOUNDS = [
  [0, 0, 833], [833, 0, 834], [1667, 0, 833],
  [0, 843, 833], [833, 843, 834], [1667, 843, 833],
] as const;

const SOURCE_SLOT: Record<Exclude<CatalogCell, null>, number> = {
  'prescription-send': 0,
  'prescription-history': 1,
  'medication-followup': 2,
  'manual-chat': 3,
  'pharmacy-info': 4,
  'all-functions': 5,
};

export function buildPharmacyRichMenuCatalogJobs(): PharmacyRichMenuCatalogJob[] {
  return listPharmacyRichMenuVariantOrders().map((orderedActions) => {
    const presentation = getPharmacyRichMenuPresentation(orderedActions);
    return {
      variantKey: presentation.variantKey,
      orderedActions,
      cells: [...orderedActions, 'all-functions'],
      size: presentation.size,
      bounds: presentation.bounds,
    };
  });
}

function runMagick(binary: string, args: string[]) {
  execFileSync(binary, args, { stdio: 'ignore' });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<{ bytes: Uint8Array; hash: string }> {
  const bytes = new Uint8Array(await readFile(path));
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') };
}

export async function generatePharmacyRichMenuCatalog(input: {
  source: string;
  output: string;
  magick?: string;
}): Promise<{ entries: number; manifestPath: string }> {
  const source = resolve(input.source);
  const output = resolve(input.output);
  if (await exists(output)) throw new Error(`output already exists: ${output}`);
  const sourceBytes = await sha256File(source);
  const sourceValidation = validateRichMenuImage(sourceBytes.bytes, sourceBytes.bytes.byteLength);
  if (!sourceValidation.ok || sourceValidation.size !== 'large' || sourceValidation.format !== 'jpeg') {
    throw new Error('source must be a LINE-compliant 2500x1686 JPEG');
  }
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'pharmacy-rich-menu-catalog-'));
  const magick = input.magick ?? 'magick';
  try {
    const tiles = new Map<Exclude<CatalogCell, null>, string>();
    for (const [key, slot] of Object.entries(SOURCE_SLOT) as Array<[Exclude<CatalogCell, null>, number]>) {
      const [x, y, width] = SLOT_BOUNDS[slot];
      const tile = join(temporary, `${key}.png`);
      runMagick(magick, [source, '-crop', `${width}x843+${x}+${y}`, '+repage', tile]);
      tiles.set(key, tile);
    }

    const entries = [];
    for (const job of buildPharmacyRichMenuCatalogJobs()) {
      const fileName = `${job.variantKey}.jpg`;
      const path = join(output, fileName);
      const height = job.size === 'large' ? 1686 : 843;
      const args = ['-size', `2500x${height}`, 'xc:#f3fff8'];
      job.cells.forEach((cell, slot) => {
        const { x, y, width, height: cellHeight } = job.bounds[slot];
        args.push(
          '(', tiles.get(cell)!, '-resize', `${width}x${cellHeight}`,
          '-background', '#f3fff8', '-gravity', 'center', '-extent', `${width}x${cellHeight}`, ')',
          '-geometry', `+${x}+${y}`, '-composite',
        );
      });
      const borders = job.bounds.map(({ x, y, width, height: cellHeight }) =>
        `rectangle ${x},${y} ${x + width},${y + cellHeight}`).join(' ');
      args.push(
        '-fill', 'none', '-stroke', '#dbe7e1', '-strokewidth', '4',
        '-draw', borders,
        '-strip', '-interlace', 'Plane', '-quality', '82', path,
      );
      runMagick(magick, args);
      const generated = await sha256File(path);
      const validation = validateRichMenuImage(generated.bytes, generated.bytes.byteLength);
      if (!validation.ok || validation.size !== job.size || validation.format !== 'jpeg') {
        throw new Error(`generated image is invalid: ${fileName}`);
      }
      entries.push({
        variantKey: job.variantKey,
        orderedActions: job.orderedActions,
        objectKey: `rich-menu-catalog/${PHARMACY_RICH_MENU_CATALOG_VERSION}/${fileName}`,
        imageHash: generated.hash,
        width: 2500,
        height,
        size: job.size,
        contentType: 'image/jpeg',
        bytes: generated.bytes.byteLength,
      });
    }
    const manifestPath = join(output, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify({
      catalogVersion: PHARMACY_RICH_MENU_CATALOG_VERSION,
      sourceImage: basename(source),
      sourceImageHash: sourceBytes.hash,
      entries,
    }, null, 2)}\n`);
    return { entries: entries.length, manifestPath };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = argument(process.argv.slice(2), 'output');
  if (!output) throw new Error('--output is required');
  const source = argument(process.argv.slice(2), 'source') ??
    'apps/worker/public/custom/pharmacy/rich-menu/initial-large-3x2-v4.jpg';
  generatePharmacyRichMenuCatalog({
    source,
    output,
    magick: argument(process.argv.slice(2), 'magick'),
  }).then((result) => process.stdout.write(
    `Generated ${result.entries} variants and ${result.manifestPath}\n`,
  ));
}

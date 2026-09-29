import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCREENSHOTS_DIR = join(process.cwd(), 'screenshots');

const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
  'base64',
);

export async function writePlaceholderScreenshot(reportId: string, stepIndex: number): Promise<string> {
  const dir = join(SCREENSHOTS_DIR, reportId);
  await mkdir(dir, { recursive: true });
  const filename = `step-${stepIndex}.png`;
  await writeFile(join(dir, filename), TRANSPARENT_PNG);
  return `/screenshots/${reportId}/${filename}`;
}

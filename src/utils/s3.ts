import { XMLParser } from 'fast-xml-parser';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

const S3_BASE = 'https://noaa-mrms-pds.s3.amazonaws.com';

export function buildListUrl(prefix: string, maxKeys: number = 20): string {
  return `${S3_BASE}/?list-type=2&prefix=${prefix}&max-keys=${maxKeys}`;
}

export function buildFileUrl(key: string): string {
  return `${S3_BASE}/${key}`;
}

export function parseS3ListResponse(xml: string): string[] {
  const parser = new XMLParser({ processEntities: false });
  const parsed = parser.parse(xml);
  const result = parsed?.ListBucketResult;
  if (!result?.Contents) return [];

  const contents = Array.isArray(result.Contents)
    ? result.Contents
    : [result.Contents];

  return contents.map((c: { Key: string }) => c.Key);
}

export async function listObjects(prefix: string): Promise<string[]> {
  const url = buildListUrl(prefix);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`S3 list failed: ${response.status} ${response.statusText}`);
  }
  const xml = await response.text();
  return parseS3ListResponse(xml);
}

export async function downloadAndGunzip(key: string, outputPath: string): Promise<number> {
  await mkdir(path.dirname(outputPath), { recursive: true });

  const url = buildFileUrl(key);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`S3 download failed: ${response.status} ${response.statusText}`);
  }

  const fileSize = parseInt(response.headers.get('content-length') || '0', 10);
  const body = response.body;
  if (!body) throw new Error('No response body');

  const gunzip = createGunzip();
  const output = createWriteStream(outputPath);

  await pipeline(
    Readable.fromWeb(body as any),
    gunzip,
    output,
  );

  return fileSize;
}

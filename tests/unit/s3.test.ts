import { describe, it, expect } from 'vitest';
import { parseS3ListResponse, buildListUrl, buildFileUrl } from '../../src/utils/s3.js';

describe('buildListUrl', () => {
  it('constructs correct S3 list URL with default max-keys', () => {
    const url = buildListUrl('CONUS/SeamlessHSR_00.00/');
    expect(url).toBe(
      'https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=CONUS/SeamlessHSR_00.00/&max-keys=20'
    );
  });
});

describe('buildFileUrl', () => {
  it('constructs correct S3 file download URL', () => {
    const url = buildFileUrl('CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143200.grib2.gz');
    expect(url).toBe(
      'https://noaa-mrms-pds.s3.amazonaws.com/CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143200.grib2.gz'
    );
  });
});

describe('parseS3ListResponse', () => {
  it('extracts keys from S3 XML response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Contents>
    <Key>CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143200.grib2.gz</Key>
    <LastModified>2026-03-18T14:32:30.000Z</LastModified>
    <Size>3145728</Size>
  </Contents>
  <Contents>
    <Key>CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143000.grib2.gz</Key>
    <LastModified>2026-03-18T14:30:30.000Z</LastModified>
    <Size>3100000</Size>
  </Contents>
</ListBucketResult>`;
    const keys = parseS3ListResponse(xml);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe('CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143200.grib2.gz');
    expect(keys[1]).toBe('CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143000.grib2.gz');
  });

  it('returns empty array for empty response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
</ListBucketResult>`;
    const keys = parseS3ListResponse(xml);
    expect(keys).toHaveLength(0);
  });

  it('handles single item response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Contents>
    <Key>CONUS/SeamlessHSR_00.00/MRMS_SeamlessHSR_00.00_20260318-143200.grib2.gz</Key>
    <LastModified>2026-03-18T14:32:30.000Z</LastModified>
    <Size>3145728</Size>
  </Contents>
</ListBucketResult>`;
    const keys = parseS3ListResponse(xml);
    expect(keys).toHaveLength(1);
  });
});

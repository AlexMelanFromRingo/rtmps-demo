import {
  CreateBucketCommand, DeleteObjectsCommand, HeadBucketCommand, ListObjectsV2Command,
  PutBucketPolicyCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.ts';
import { log } from './log.ts';

// Any S3-compatible store works (SeaweedFS in compose; AWS S3, R2, Ceph RGW,
// Garage in production). Path-style addressing for self-hosted stores.
export const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  // Newer SDKs add CRC checksums + aws-chunked bodies by default, which many
  // S3-compatible servers reject. Only send them when an API requires it.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  maxAttempts: 3,
});

const bucket = config.s3.bucket;

export async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      log.info({ bucket }, 'created bucket');
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
    }
  }
  if (config.s3.publicRead) {
    const policy = {
      Version: '2012-10-17',
      Statement: [{
        Sid: 'PublicReadForEdge', Effect: 'Allow', Principal: '*',
        Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`],
      }],
    };
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  }
}

export async function putObject(key: string, body: Buffer | string, contentType: string, cacheControl: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl,
  }));
}

export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
    const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      deleted += objects.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

// Object layout (shared contract between worker, control plane and edge).
export const objectKeys = {
  prefix: (broadcastId: string) => `live/${broadcastId}/`,
  master: (broadcastId: string) => `live/${broadcastId}/master.m3u8`,
  thumbnail: (broadcastId: string) => `live/${broadcastId}/thumb.jpg`,
};

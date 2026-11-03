import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  av1CodecString, bitDepth, codecName, estimateAv1Level, h264CodecString, h264LevelFor, hevcCodecString,
} from '../../src/worker/codecs.ts';

test('codecName maps ffmpeg names to display names', () => {
  assert.equal(codecName('h264'), 'H264');
  assert.equal(codecName('hevc'), 'H265');
  assert.equal(codecName('av1'), 'AV1');
  assert.equal(codecName('opus'), 'Opus');
  assert.equal(codecName('weird'), 'WEIRD');
  assert.equal(codecName(undefined), null);
});

test('h264 codec strings follow RFC 6381', () => {
  assert.equal(h264CodecString('High', 40), 'avc1.640028');
  assert.equal(h264CodecString('Main', 31), 'avc1.4d401f');
  assert.equal(h264CodecString('Constrained Baseline', 31), 'avc1.42c01f');
  assert.equal(h264CodecString(undefined, undefined), 'avc1.640028'); // safe default
});

test('hevc codec strings', () => {
  assert.equal(hevcCodecString('Main', 93), 'hvc1.1.6.L93.B0');
  assert.equal(hevcCodecString('Main 10', 150), 'hvc1.2.4.L150.B0');
  assert.equal(hevcCodecString('Main', -99 as number), 'hvc1.1.6.L120.B0');
});

test('av1 codec strings and level estimation', () => {
  assert.equal(av1CodecString('Main', 8, 8, 1920, 1080, 30), 'av01.0.08M.08');
  assert.equal(av1CodecString('Main', undefined, 10, 1920, 1080, 60), 'av01.0.09M.10');
  assert.equal(estimateAv1Level(1280, 720, 30), 5);
  assert.equal(estimateAv1Level(3840, 2160, 60), 13);
});

test('bitDepth from pix_fmt', () => {
  assert.equal(bitDepth('yuv420p'), 8);
  assert.equal(bitDepth('yuv420p10le'), 10);
  assert.equal(bitDepth('p010le'), 10);
  assert.equal(bitDepth('yuv422p12le'), 12);
});

test('h264LevelFor picks a level that fits the rendition', () => {
  assert.equal(h264LevelFor(1920, 1080, 60), 42);
  assert.equal(h264LevelFor(1920, 1080, 30), 40);
  assert.equal(h264LevelFor(1280, 720, 30), 31);
  assert.equal(h264LevelFor(640, 360, 30), 30);
});

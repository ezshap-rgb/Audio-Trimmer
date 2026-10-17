/**
 * Re-encode a trimmed In→Out region of an already-recorded file.
 *
 * This is the one feature that requires a development build: `react-native-audio-api`
 * is a native package (not in Expo Go), and it provides the only local-file decode
 * path that returns PCM we can re-encode.
 *
 * The rest of the pipeline — WAV sink with header patching, the LAME MP3 encoder
 * via @breezystack/lamejs, the ExpoFileWriter that streams to disk — is all reused
 * from the recorder. The trimmed file is written to a temp file in the Recordings
 * folder first, the original is deleted, then the temp is renamed onto the original's
 * path so the recording's `uri` never changes.
 */
import { Mp3Sink } from '../core/mp3';
import { WavSink } from '../core/wav';
import { ExpoFileWriter } from '../platform/fileWriter';
import { RecordingEntry, recordingsDirectory } from '../storage/recordings';
import {
  CAPTURE_CHANNELS,
  CAPTURE_SAMPLE_RATE,
  BITS_PER_SAMPLE,
  type Settings,
} from '../core/types';
import { File } from 'expo-file-system';
import { createMp3Encoder } from '../platform/mp3Encoder';
import type { TrimRegion, TrimResult } from '../screens/TrimmerScreen.types';
import type { Mp3EncoderFactory } from '../platform/mp3Encoder';

// The actual decode path uses react-native-audio-api (native; not in Expo Go).
// It is provided by the SWMansion package and must be present in the development
// build before trimming can run.
import { decodeAudioData } from 'react-native-audio-api';

export async function trimAndReplace(
  entry: RecordingEntry,
  region: TrimRegion,
  settings: Settings,
  createEncoder: Mp3EncoderFactory
): Promise<TrimResult> {
  const format = entry.format ?? settings.format;
  const directory = recordingsDirectory();

  let decoded: Float32Array;
  let decodedSampleRate = 0;

  // 1. Decode the whole recording into PCM so we can re-encode the trimmed
  //    region with the same encoders the recorder already uses.
  //
  //    react-native-audio-api returns Float32 PCM in [-1, 1] with the source
  //    sample rate and channel count. We resample/convert to the capture format
  //    (mono 16 kHz, 16-bit) before feeding it to the encoder.
  try {
    const buffer = await decodeAudioData(entry.uri);
    if (buffer.numberOfChannels < 1) {
      throw new Error('Decoded audio has no channels.');
    }
    const source = buffer.getChannelData(0);
    decodedSampleRate = buffer.sampleRate;
    if (decodedSampleRate === CAPTURE_SAMPLE_RATE) {
      decoded = source;
    } else {
      const targetLength = Math.round(source.length * (CAPTURE_SAMPLE_RATE / decodedSampleRate));
      const resampled = new Float32Array(targetLength);
      for (let i = 0; i < targetLength; i++) {
        const srcPos = (i * decodedSampleRate) / CAPTURE_SAMPLE_RATE;
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;
        const a = source[Math.min(srcIdx, source.length - 1)];
        const b = source[Math.min(srcIdx + 1, source.length - 1)];
        resampled[i] = a + (b - a) * frac;
      }
      decoded = resampled;
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Failed to decode the selected recording.';
    throw new Error(
      `Could not decode the recording for trimming: ${message}. Make sure react-native-audio-api is installed in the development build used to open this app.`
    );
  }

  // --- step 2: re-encode the selected region ---
  const samplesIn = Math.round(region.keepStartSeconds * CAPTURE_SAMPLE_RATE);
  const samplesOut = Math.round(region.keepEndSeconds * CAPTURE_SAMPLE_RATE);
  const decodedLength = decoded.length;

  if (samplesIn >= decodedLength || samplesOut > decodedLength) {
    throw new Error('Trim region is outside the decoded audio.');
  }

  const baseName = entry.name.replace(/\.[^/.]+$/, '');
  const tempName = `${baseName}.tmp.mp3`;
  const tempFile = new File(directory, tempName);
  if (tempFile.exists) {
    tempFile.delete();
  }

  const writer = new ExpoFileWriter(tempFile);
  writer.open();

  const encoder = createEncoder(CAPTURE_CHANNELS, CAPTURE_SAMPLE_RATE, settings.bitrate);
  const sink =
    format === 'wav'
      ? new WavSink(writer, {
          sampleRate: CAPTURE_SAMPLE_RATE,
          channels: CAPTURE_CHANNELS,
          bitsPerSample: BITS_PER_SAMPLE,
        })
      : new Mp3Sink(writer, CAPTURE_SAMPLE_RATE, settings.bitrate, createEncoder, CAPTURE_CHANNELS);

  sink.begin();

  const chunkSize = 1152;
  for (let offset = 0; offset < decodedLength; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, decodedLength);
    const raw = decoded.subarray(samplesIn + offset, samplesIn + end);
    const pcm = new Int16Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(raw[i] * 32767)));
    }
    sink.write(pcm);
  }

  sink.finish();
  writer.close();

  // --- step 3: replace the original in place ---
  if (!tempFile.exists) {
    throw new Error('Failed to write trimmed file.');
  }

  tempFile.rename(entry.name);

  const finalFile = new File(directory, entry.name);
  const finalSize = (finalFile.size ?? 0) | 0;
  const finalDuration = decodedLength / CAPTURE_SAMPLE_RATE;

  return {
    entry: { ...entry, sizeBytes: finalSize },
    bytes: finalSize,
    durationSeconds: finalDuration,
  };
}

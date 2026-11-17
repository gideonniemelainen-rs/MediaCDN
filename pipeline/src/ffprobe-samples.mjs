// ffprobe-shaped JSON for the cases ingest has to handle, so unit tests need no ffmpeg.

const video = (over = {}) => ({
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  pix_fmt: 'yuv420p',
  sample_aspect_ratio: '1:1',
  r_frame_rate: '30/1',
  avg_frame_rate: '30/1',
  field_order: 'progressive',
  disposition: { attached_pic: 0 },
  ...over,
})

const audio = (over = {}) => ({
  codec_type: 'audio',
  codec_name: 'aac',
  channels: 2,
  channel_layout: 'stereo',
  sample_rate: '48000',
  disposition: { default: 1 },
  ...over,
})

const probed = (streams, format = {}) => ({
  streams,
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '60.0', size: '10000000', bit_rate: '1333333', ...format },
})

export const samples = {
  clean: () => probed([video(), audio()]),
  screenSilent: () => probed([video({ r_frame_rate: '10/1', avg_frame_rate: '10/1', width: 2560, height: 1440 })]),
  // Windows screen recorders often report 1000 fps timebase with a low average.
  screenVfr: () => probed([video({ r_frame_rate: '60/1', avg_frame_rate: '4/1', width: 1920, height: 1080 })]),
  phoneRotated: () =>
    probed([
      video({ width: 1080, height: 1920, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }),
      audio(),
    ]),
  legacyRotateTag: () => probed([video({ width: 1080, height: 1920, tags: { rotate: '90' } }), audio()]),
  hdr: () =>
    probed([
      video({
        codec_name: 'hevc',
        pix_fmt: 'yuv420p10le',
        bits_per_raw_sample: '10',
        color_primaries: 'bt2020',
        color_transfer: 'smpte2084',
        color_space: 'bt2020nc',
        width: 3840,
        height: 2160,
      }),
      audio(),
    ]),
  tenBitSdr: () => probed([video({ pix_fmt: 'yuv420p10le', color_transfer: 'bt709' }), audio()]),
  anamorphic: () => probed([video({ width: 1440, height: 1080, sample_aspect_ratio: '4:3' }), audio()]),
  interlaced: () => probed([video({ codec_name: 'mpeg2video', field_order: 'tt' }), audio()]),
  oddDimensions: () => probed([video({ width: 1279, height: 719 }), audio()]),
  multiAudio: () => probed([video(), audio(), audio({ default: undefined, disposition: { default: 0 } })]),
  multiAudioSecondDefault: () =>
    probed([video(), audio({ disposition: { default: 0 } }), audio({ disposition: { default: 1 } })]),
  audioOnly: () => probed([audio()]),
  noStreams: () => probed([]),
  coverArtOnly: () => probed([video({ codec_name: 'mjpeg', disposition: { attached_pic: 1 } }), audio()]),
  tooLong: () => probed([video(), audio()], { duration: '9000.0' }),
  tooBig: () => probed([video(), audio()], { size: String(20 * 1024 ** 3) }),
  tooWide: () => probed([video({ width: 7680, height: 4320 }), audio()]),
  tiny: () => probed([video({ width: 16, height: 16 }), audio()]),
  badCodec: () => probed([video({ codec_name: 'wmv3' }), audio()]),
  noDuration: () => probed([video(), audio()], { duration: 'N/A' }),
  ultrawide: () => probed([video({ width: 3840, height: 600 }), audio()]),
}

/**
 * Exact RFC 6381 / ISO/IEC 14496-15 codec strings from decoder configuration
 * records, as required in the HLS CODECS attribute. Deriving them from the
 * bitstream (rather than from profile names) is what lets Safari select and
 * decode a passthrough variant correctly.
 */
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** AVCDecoderConfigurationRecord -> `avc1.PPCCLL`. */
export function avcCodecString(avcC: Uint8Array): string {
  if (avcC.length < 4 || avcC[0] !== 1) throw new Error('Invalid avcC record');
  return `avc1.${hex2(avcC[1] ?? 0)}${hex2(avcC[2] ?? 0)}${hex2(avcC[3] ?? 0)}`;
}

/** HEVCDecoderConfigurationRecord -> e.g. `hvc1.2.4.L150.90` (always the hvc1 sample entry). */
export function hevcCodecString(hvcC: Uint8Array): string {
  if (hvcC.length < 13 || hvcC[0] !== 1) throw new Error('Invalid hvcC record');
  const b1 = hvcC[1] ?? 0;
  const profileSpace = ['', 'A', 'B', 'C'][b1 >> 6] ?? '';
  const tier = (b1 & 0x20) !== 0 ? 'H' : 'L';
  const profileIdc = b1 & 0x1f;
  const compat =
    (((hvcC[2] ?? 0) << 24) | ((hvcC[3] ?? 0) << 16) | ((hvcC[4] ?? 0) << 8) | (hvcC[5] ?? 0)) >>>
    0;
  let reversed = 0;
  for (let i = 0; i < 32; i++) {
    if ((compat >>> i) & 1) reversed = (reversed | (1 << (31 - i))) >>> 0;
  }
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length > 0 && constraints.at(-1) === 0) constraints.pop();
  const level = hvcC[12] ?? 0;
  const parts = [
    'hvc1',
    `${profileSpace}${profileIdc}`,
    reversed.toString(16),
    `${tier}${level}`,
    ...constraints.map((b) => b.toString(16).toUpperCase()),
  ];
  return parts.join('.');
}

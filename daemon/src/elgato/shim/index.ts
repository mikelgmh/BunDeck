/** Barrel del shim Elgato (Worker actual, sin procesos extra). */
export * from './sdk';
export { DialNotSupportedError, isDialOnlyAction, isDialOnlyManifest } from './dial-stub';
export {
  detectElgatoCodeStyle,
  importsElgatoSdk,
  looksLikeRawProtocol,
  hasBareWsSpecifier,
  rewriteWsSpecifier,
  findRawSourceEntry,
  SHIM_IDLE_MS,
  SHIM_BRIDGE_VERSION,
  isShimEnabled,
  isShimCapable,
  needsManualReason,
  resolveCodePathFor,
  writeShimFiles,
  ensureShimBridge,
} from './loader-shim';
export type { ElgatoCodeStyle } from './detect';
export type { ShimActionMap, WriteShimOpts, WriteShimResult } from './loader-shim';
export {
  createRawHost,
  getRawHost,
  installRawGlobals,
  VirtualElgatoSocket,
  RAW_TRANSPORT_VERSION,
  RAW_HOST_KEY,
} from './raw-transport';
export type { RawHost, RawHostOptions, RawFireKeyResult } from './raw-transport';

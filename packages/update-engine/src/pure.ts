export type {
  CurrentVersion,
  CustomerSourceUpdate,
  CustomerUpdateClass,
  ForkStatus,
  Manifest,
  ReleaseEntry,
} from './types.js';
export {
  compareSemver,
  fetchManifest,
  findLatestUpgrade,
  findRelease,
  validateReleaseEntry,
} from './manifest.js';
export { detectFork } from './fork-detect.js';

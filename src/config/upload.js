import { absPath } from '#config/path.js';
import { IMAGE_PROFILE } from '#enums/image-profile.js';
import { freezeDeep } from '#utils/object.js';

export function createUploadConfig() {
  return freezeDeep({
    storage: {
      driver: 'local',
      root: absPath.upload,
      publicPath: '/upload/',

      // A key never changes its content: a browser may keep the file for good.
      maxAge: '365d',
    },

    // The ceilings of every route: a process holds at most maxActiveFiles files of maxFileSize in memory, and
    // config.app.requestTimeout must carry maxTotalSize over a slow mobile link.
    maxFileSize: '10MB',
    maxTotalSize: '10MB',

    // The most of a form the parser reads, the parts it drops included: a longer one is answered 413, once the rest of
    // its body has been read and dropped.
    maxBodySize: '12MB',

    // The header of a part, with the name of its field and of its file: the parser keeps it beside the part.
    maxPartHeaderSize: '2KB',

    // The text fields and the files of one body together: a body with more is answered 413.
    maxParts: 50,

    // The files a process reads, decodes and stores at once: one more is answered 503 once its body is read.
    maxActiveFiles: 3,

    avatarMaxSize: '5MB',

    image: {
      maxPixels: 70_000_000,

      // A frame that a decode holds whole, by the count of core/image/header.js.
      maxDecodeBytes: '96MB',
      maxJpegScans: 100,

      timeout: '20s',

      profiles: {
        [IMAGE_PROFILE.AVATAR]: { format: 'webp', quality: 80, maxSize: 512 },
      },
    },
  });
}

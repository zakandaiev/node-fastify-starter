import { getServiceSkip } from '#root/tests/helper/service.js';
import { stdout } from 'node:process';

stdout.write(String(await getServiceSkip(['redis'])));

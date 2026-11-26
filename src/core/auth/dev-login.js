import { alert } from '#core/alert/index.js';
import { signInWithEmail } from '#core/auth/account.js';
import { getContext } from '#core/context/index.js';
import { THROTTLE_CLASS } from '#enums/throttle-class.js';

const ALERT_TITLE = 'Dev sign-in';
const ALERT_KEY = 'dev-sign-in';
const ALERT_MESSAGE = 'A user has signed in by an email alone, through the sign-in of dev mode';
const KEY_SEPARATOR = ':';

// An email is all it asks: it is there in dev mode alone, and the admins hear of a user it lets in. The alert goes
// after the commit, so it never tells of a session that is not there.
export async function signInForDev({ email, client, request } = {}) {
  if (!getContext().config.app.isDev) {
    throw new Error('signInForDev({ email, client, request }) signs in by an email alone: it runs in dev mode only, APP_MODE=dev');
  }

  const issued = await signInWithEmail({ email, client, request });

  await alert({
    title: ALERT_TITLE,
    dedupeKey: [ALERT_KEY, issued.userId].join(KEY_SEPARATOR),
    error: { message: ALERT_MESSAGE, userId: issued.userId },
    throttleClass: THROTTLE_CLASS.WARNING,
    request,
    isDetached: true,
  });

  return issued;
}

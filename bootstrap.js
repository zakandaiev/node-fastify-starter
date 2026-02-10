import { appData } from '#core/app.js';

// EXTEND process.env with APP_* entities
Object.assign(process.env, appData);

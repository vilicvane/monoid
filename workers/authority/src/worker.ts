import {createWebHandler, type WebEnv} from './web.js';

export {AuthorityState} from './state.js';

export default {fetch: createWebHandler()} satisfies ExportedHandler<WebEnv>;

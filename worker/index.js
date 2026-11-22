// Worker entry: serves the parts-library API; everything else is static assets.
import { handleApi } from './api.js';

export default {
  async fetch(request, env) {
    return (await handleApi(request, env)) ?? env.ASSETS.fetch(request);
  },
};

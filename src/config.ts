const env = import.meta.env;

/** Backend base URL, without trailing slash. */
export const API_URL = (env.VITE_API_URL || 'http://localhost:7860').replace(/\/+$/, '');

/** Built-in mock backend instead of API_URL (development only). */
export const USE_MOCK = env.VITE_MOCK === 'true';

/** Link to the repository README for "How it works". Optional. */
export const REPO_URL: string | undefined = env.VITE_REPO_URL || undefined;

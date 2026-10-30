export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  ENVIRONMENT: string;
  AUTH_MODE: string;
  VERSION: string;

  DASHBOARD_HOST: string;
  API_HOST: string;
  DASHBOARD_ORIGIN: string;
  API_ORIGIN: string;

  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  GROQ_MODEL: string;
  RATE_LIMIT_PER_MIN: string;

  GROQ_API_KEY?: string;
  TOKEN_PEPPER?: string;
}

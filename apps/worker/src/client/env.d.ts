/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_CALENDAR_CONNECTION_ID: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

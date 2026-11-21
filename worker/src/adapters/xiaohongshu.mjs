import { browserAdapter } from "../shared/browser-adapter.mjs";
export { scanPage } from "../shared/scanner.mjs";
export const { login, scan, download, listFolders } = browserAdapter("xiaohongshu");

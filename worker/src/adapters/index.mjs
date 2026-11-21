// Imports have no process/network effects. First validated request owns every child.
import * as douyin from "./douyin.mjs";
import * as xiaohongshu from "./xiaohongshu.mjs";
import * as x from './x.mjs';
import * as telegram from './telegram.mjs';
export const adapters = {
  douyin,
  xiaohongshu,
  x,
  telegram,
};
